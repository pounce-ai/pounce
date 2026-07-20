/**
 * Device-setup card on the Settings screen — mobile implementation.
 *
 * The phone pairs with a computer by scanning its bridge QR (or typing the
 * address + code). Desktop overrides this per-platform: the app runs ON the
 * agent host, so its card offers resync/reset instead — see
 * DeviceSetupCard.desktop.tsx.
 */
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { PounceIcon } from "../ui/native/Icon";
import { COLOR, INPUT_TWEAKS } from "../ui";
import { T } from "../ui/theme";

export interface DeviceSetupCardProps {
  busy: boolean;
  /** Open the QR scanner (mobile) — unused by the desktop fork. */
  onScan: () => void;
  manual: boolean;
  setManual: (update: (m: boolean) => boolean) => void;
  url: string;
  setUrl: (v: string) => void;
  token: string;
  setToken: (v: string) => void;
  /** Connect to the entered address + code. */
  onSync: (p: { url: string; token: string }) => void;
}

export function DeviceSetupCard({
  busy,
  onScan,
  manual,
  setManual,
  url,
  setUrl,
  token,
  setToken,
  onSync,
}: DeviceSetupCardProps) {
  return (
    <View style={s.card}>
      <Text style={s.cardTitle}>Pair a device</Text>
      <Text style={s.cardBody}>
        On your computer, show its pairing code, then scan it here. Once paired, your sessions sync automatically.
      </Text>
      <Pressable
        onPress={onScan}
        disabled={busy}
        style={({ pressed }) => [s.scanBtn, busy && s.disabled50, pressed && s.pressed90]}
      >
        <PounceIcon name="qr-code-outline" size={18} color={T.onAccent} />
        <Text style={s.scanText}>Scan pairing code</Text>
      </Pressable>
      <Pressable onPress={() => setManual((m) => !m)} style={({ pressed }) => [s.manualToggle, pressed && s.pressed60]}>
        <Text style={s.manualToggleText}>{manual ? "Hide manual entry" : "Enter code manually"}</Text>
      </Pressable>

      {manual ? (
        <View style={s.manualSection}>
          <Text style={s.fieldLabel}>Address</Text>
          <TextInput {...INPUT_TWEAKS}
            value={url}
            onChangeText={setUrl}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            placeholder="http://192.168.1.6:8099"
            placeholderTextColor={COLOR.fgFaint}
            style={s.input}
          />
          <Text style={s.fieldLabel}>Code</Text>
          <TextInput {...INPUT_TWEAKS}
            value={token}
            onChangeText={setToken}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="pairing code"
            placeholderTextColor={COLOR.fgFaint}
            style={s.input}
          />
          <Pressable
            onPress={() => onSync({ url, token })}
            disabled={busy || !url.trim() || !token.trim()}
            style={({ pressed }) => [
              s.syncBtn,
              (busy || !url.trim() || !token.trim()) && s.disabled40,
              pressed && s.pressed90,
            ]}
          >
            {busy ? <ActivityIndicator size="small" color={COLOR.fgMuted} /> : null}
            <Text style={s.syncText}>{busy ? "Connecting…" : "Sync"}</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    gap: 12,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: T.border,
    backgroundColor: T.surface,
    padding: 16,
  },
  cardTitle: { fontSize: 17, fontWeight: "600", color: T.fg },
  cardBody: { fontSize: 13, lineHeight: 19, color: T.fgMuted },
  scanBtn: {
    marginTop: 4,
    height: 48,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderRadius: 12,
    backgroundColor: T.accent,
  },
  scanText: { fontSize: 15, fontWeight: "600", color: T.onAccent },
  manualToggle: { alignSelf: "center", paddingTop: 4 },
  manualToggleText: { fontSize: 13, color: T.fgMuted },
  manualSection: { gap: 8, borderTopWidth: 1, borderColor: T.border, paddingTop: 12 },
  fieldLabel: { fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5, color: T.fgFaint },
  input: {
    borderRadius: 12,
    backgroundColor: T.surfaceAlt,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontFamily: "JetBrainsMono",
    fontSize: 13,
    color: T.fg,
  },
  syncBtn: {
    marginTop: 4,
    height: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderRadius: 12,
    backgroundColor: T.surfaceAlt,
  },
  syncText: { fontSize: 14, fontWeight: "600", color: T.fg },
  disabled40: { opacity: 0.4 },
  disabled50: { opacity: 0.5 },
  pressed60: { opacity: 0.6 },
  pressed90: { opacity: 0.9 },
});
