/**
 * QR scanner — desktop implementation. No camera pipeline on macOS/Windows
 * (expo-camera has no desktop build); pairing on desktop is automatic for the
 * local bridge and manual (URL + token) for other machines, so this fork just
 * points the user at the manual path.
 */
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

export default function QrScanner({
  onCancel,
}: {
  onScan: (data: string) => void;
  onCancel: () => void;
}) {
  return (
    <View style={s.root}>
      <Text style={s.emoji}>📷</Text>
      <Text style={s.title}>No camera scanning on desktop</Text>
      <Text style={s.body}>
        This Mac's bridge connects automatically. To add another machine, use “Enter code manually”
        with its address and token.
      </Text>
      <Pressable onPress={onCancel} style={({ pressed }) => [s.backBtn, pressed && s.pressed80]}>
        <Text style={s.backText}>Back</Text>
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    backgroundColor: theme.colors.bg,
    paddingHorizontal: 32,
  },
  emoji: { fontSize: 28 },
  title: { textAlign: "center", fontSize: 14, fontWeight: "600", color: theme.colors.fg },
  body: { textAlign: "center", fontSize: 12.5, color: theme.colors.fgMuted },
  backBtn: {
    marginTop: 8,
    borderRadius: 999,
    backgroundColor: theme.colors.surfaceAlt,
    paddingHorizontal: 20,
    paddingVertical: 8,
  },
  backText: { fontSize: 13, fontWeight: "500", color: theme.colors.fg },
  pressed80: { opacity: 0.8 },
}));
