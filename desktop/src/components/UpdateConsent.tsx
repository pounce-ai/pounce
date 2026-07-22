/**
 * One-time auto-update consent. On first launch (once the app has settled), if
 * the Sparkle updater is available and the user hasn't been asked yet, offer to
 * enable automatic updates. Either choice is remembered; it can be changed later
 * from Settings. Asked once — never nags again.
 */
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Modal } from "@pounce/app/components/AppModal";
import { COLOR } from "@pounce/app/ui";
import { T } from "@pounce/app/ui/theme";
import { isUpdaterSupported, setAutoUpdateEnabled } from "@pounce/app/services/updater";

const ASKED_KEY = "pounce.updateConsentAsked";

export function UpdateConsent() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let alive = true;
    const t = setTimeout(async () => {
      try {
        const asked = await AsyncStorage.getItem(ASKED_KEY);
        if (asked) return;
        if (!(await isUpdaterSupported())) return;
        if (alive) setVisible(true);
      } catch {}
    }, 4_000); // let the window paint + bridge connect first
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, []);

  const decide = async (enable: boolean) => {
    setVisible(false);
    try {
      await AsyncStorage.setItem(ASKED_KEY, "1");
    } catch {}
    if (enable) setAutoUpdateEnabled(true);
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={() => void decide(false)}>
      <View style={[StyleSheet.absoluteFill, s.host]}>
        <View style={[StyleSheet.absoluteFill, s.scrim]} />
        <View style={s.card}>
          <Text style={s.title}>Keep Pounce up to date?</Text>
          <Text style={s.body}>
            Pounce can automatically download and install new versions in the background, verified
            with a signature. You can change this anytime in Settings.
          </Text>
          <View style={s.buttonRow}>
            <Pressable
              onPress={() => void decide(false)}
              style={({ pressed }) => [s.declineBtn, pressed && s.pressed70]}
            >
              <Text style={s.declineLabel}>Not now</Text>
            </Pressable>
            <Pressable
              onPress={() => void decide(true)}
              style={({ pressed }) => [
                s.acceptBtn,
                { shadowColor: COLOR.accent, shadowOpacity: 0.3, shadowRadius: 8 },
                pressed && s.pressed80,
              ]}
            >
              <Text style={s.acceptLabel}>Enable automatic updates</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  host: { alignItems: "center", justifyContent: "center" },
  scrim: { backgroundColor: T.overlay },
  card: {
    width: 380,
    gap: 12,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: T.border,
    backgroundColor: T.bgElevated,
    padding: 20,
  },
  title: { fontSize: 16, fontWeight: "600", color: T.fg },
  body: { fontSize: 13, lineHeight: 19, color: T.fgMuted },
  buttonRow: { marginTop: 4, flexDirection: "row", justifyContent: "flex-end", gap: 8 },
  declineBtn: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: T.border,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  declineLabel: { fontSize: 13, fontWeight: "500", color: T.fgMuted },
  acceptBtn: {
    borderRadius: 8,
    backgroundColor: T.accent,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  acceptLabel: { fontSize: 13, fontWeight: "600", color: T.onAccent },
  pressed70: { opacity: 0.7 },
  pressed80: { opacity: 0.8 },
});
