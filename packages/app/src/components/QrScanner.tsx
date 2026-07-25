import { useEffect } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CameraView, useCameraPermissions } from "expo-camera";

/**
 * Full-screen QR scanner. Lives in its own module so it's only loaded
 * (dynamic import) once the native expo-camera is in the build — keeping the
 * Sync screen crash-free in dev clients that don't have it yet.
 */
export default function QrScanner({
  onScan,
  onCancel,
}: {
  onScan: (data: string) => void;
  onCancel: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();

  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain) void requestPermission();
  }, [permission, requestPermission]);

  if (!permission?.granted) {
    return (
      <View style={[s.permission, { paddingTop: insets.top }]}>
        <Text style={s.permissionTitle}>Camera access needed</Text>
        <Text style={s.permissionBody}>Allow the camera to scan a pairing code.</Text>
        <Pressable
          onPress={() => void requestPermission()}
          style={({ pressed }) => [s.allowBtn, pressed && s.pressed90]}
        >
          <Text style={s.allowText}>Allow camera</Text>
        </Pressable>
        <Pressable
          onPress={onCancel}
          style={({ pressed }) => [s.cancelLink, pressed && s.pressed60]}
        >
          <Text style={s.cancelLinkText}>Cancel</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={s.camera}>
      <CameraView
        style={{ flex: 1 }}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={({ data }) => onScan(data)}
      />
      <View style={[s.hint, { paddingTop: insets.top + 8 }]}>
        <Text style={s.hintText}>Point at the pairing code</Text>
      </View>
      <Pressable
        onPress={onCancel}
        style={({ pressed }) => [
          s.cancelBtn,
          { bottom: insets.bottom + 28 },
          pressed && s.pressed80,
        ]}
      >
        <Text style={s.cancelBtnText}>Cancel</Text>
      </Pressable>
    </View>
  );
}

// Overlay text/chrome sits on live camera video, so it stays literal white/black
// regardless of the system appearance.
const s = StyleSheet.create((theme) => ({
  permission: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.bg,
    paddingHorizontal: 32,
  },
  permissionTitle: { textAlign: "center", fontSize: 15, fontWeight: "600", color: theme.colors.fg },
  permissionBody: { marginTop: 4, textAlign: "center", fontSize: 13, color: theme.colors.fgMuted },
  allowBtn: {
    marginTop: 20,
    borderRadius: 12,
    backgroundColor: theme.colors.accent,
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  allowText: { fontSize: 14, fontWeight: "600", color: theme.colors.onAccent },
  cancelLink: { marginTop: 12 },
  cancelLinkText: { fontSize: 14, color: theme.colors.fgMuted },
  camera: { flex: 1, backgroundColor: "#000" },
  hint: { position: "absolute", left: 0, right: 0, top: 0, alignItems: "center" },
  hintText: { fontSize: 15, fontWeight: "500", color: "#fff" },
  cancelBtn: {
    position: "absolute",
    alignSelf: "center",
    borderRadius: 999,
    backgroundColor: "rgba(255, 255, 255, 0.15)",
    paddingHorizontal: 24,
    paddingVertical: 12,
  },
  cancelBtnText: { fontSize: 15, fontWeight: "600", color: "#fff" },
  pressed60: { opacity: 0.6 },
  pressed80: { opacity: 0.8 },
  pressed90: { opacity: 0.9 },
}));
