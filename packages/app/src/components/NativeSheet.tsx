import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Modal } from "./AppModal";

export interface NativeSheetProps {
  visible: boolean;
  onClose: () => void;
  children: ReactNode;
}

/** Desktop/default bottom sheet: the classic RN-Modal slide-up with scrim.
 *  iOS/Android resolve NativeSheetTrue instead — a real draggable
 *  UISheetPresentationController sheet (react-native-true-sheet). */
export function NativeSheet({ visible, onClose, children }: NativeSheetProps) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={s.scrim} onPress={onClose} />
      <View style={[s.sheet, { paddingBottom: insets.bottom + 12 }]}>{children}</View>
    </Modal>
  );
}

const s = StyleSheet.create((theme) => ({
  scrim: { flex: 1, backgroundColor: theme.colors.overlay },
  sheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.bgElevated,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
}));
