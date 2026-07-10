import { useEffect } from "react";
import { Pressable, Text, View } from "react-native";
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
      <View className="flex-1 items-center justify-center bg-bg px-8" style={{ paddingTop: insets.top }}>
        <Text className="text-center text-[15px] font-semibold text-fg">Camera access needed</Text>
        <Text className="mt-1 text-center text-[13px] text-fg-muted">Allow the camera to scan a pairing code.</Text>
        <Pressable onPress={() => void requestPermission()} className="active:opacity-90 mt-5 rounded-xl bg-accent px-5 py-2.5">
          <Text className="text-[14px] font-semibold text-white">Allow camera</Text>
        </Pressable>
        <Pressable onPress={onCancel} className="active:opacity-60 mt-3">
          <Text className="text-[14px] text-fg-muted">Cancel</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-black">
      <CameraView
        style={{ flex: 1 }}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={({ data }) => onScan(data)}
      />
      <View style={{ paddingTop: insets.top + 8 }} className="absolute inset-x-0 top-0 items-center">
        <Text className="text-[15px] font-medium text-white">Point at the pairing code</Text>
      </View>
      <Pressable
        onPress={onCancel}
        style={{ bottom: insets.bottom + 28 }}
        className="active:opacity-80 absolute self-center rounded-full bg-white/15 px-6 py-3"
      >
        <Text className="text-[15px] font-semibold text-white">Cancel</Text>
      </Pressable>
    </View>
  );
}
