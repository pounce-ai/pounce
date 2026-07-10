/**
 * QR scanner — desktop implementation. No camera pipeline on macOS/Windows
 * (expo-camera has no desktop build); pairing on desktop is automatic for the
 * local bridge and manual (URL + token) for other machines, so this fork just
 * points the user at the manual path.
 */
import { Pressable, Text, View } from "react-native";

export default function QrScanner({
  onCancel,
}: {
  onScan: (data: string) => void;
  onCancel: () => void;
}) {
  return (
    <View className="flex-1 items-center justify-center gap-3 bg-bg px-8">
      <Text className="text-[28px]">📷</Text>
      <Text className="text-center text-[14px] font-semibold text-fg">
        No camera scanning on desktop
      </Text>
      <Text className="text-center text-[12.5px] text-fg-muted">
        This Mac's bridge connects automatically. To add another machine, use
        “Enter code manually” with its address and token.
      </Text>
      <Pressable onPress={onCancel} className="active:opacity-80 mt-2 rounded-full bg-surface-alt px-5 py-2">
        <Text className="text-[13px] font-medium text-fg">Back</Text>
      </Pressable>
    </View>
  );
}
