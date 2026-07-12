/**
 * One-time auto-update consent. On first launch (once the app has settled), if
 * the Sparkle updater is available and the user hasn't been asked yet, offer to
 * enable automatic updates. Either choice is remembered; it can be changed later
 * from Settings. Asked once — never nags again.
 */
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Modal } from "@litter/app/components/AppModal";
import { COLOR } from "@litter/app/ui";
import { isUpdaterSupported, setAutoUpdateEnabled } from "@litter/app/services/updater";

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
      <View style={StyleSheet.absoluteFill} className="items-center justify-center">
        <View style={StyleSheet.absoluteFill} className="bg-black/60" />
        <View className="w-[380px] gap-3 rounded-2xl border border-border bg-bg-elevated p-5">
          <Text className="text-[16px] font-semibold text-fg">Keep Pounce up to date?</Text>
          <Text className="text-[13px] leading-[19px] text-fg-muted">
            Pounce can automatically download and install new versions in the background, verified
            with a signature. You can change this anytime in Settings.
          </Text>
          <View className="mt-1 flex-row justify-end gap-2">
            <Pressable
              onPress={() => void decide(false)}
              className="active:opacity-70 rounded-lg border border-border px-3.5 py-2"
            >
              <Text className="text-[13px] font-medium text-fg-muted">Not now</Text>
            </Pressable>
            <Pressable
              onPress={() => void decide(true)}
              className="active:opacity-80 rounded-lg bg-accent px-3.5 py-2"
              style={{ shadowColor: COLOR.accent, shadowOpacity: 0.3, shadowRadius: 8 }}
            >
              <Text className="text-[13px] font-semibold text-white">Enable automatic updates</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}
