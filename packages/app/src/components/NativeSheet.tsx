import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Modal } from "./AppModal";

export interface NativeSheetProps {
  visible: boolean;
  onClose: () => void;
  children: ReactNode;
}

/**
 * Desktop/default sheet — a centred floating panel, not a bottom sheet.
 *
 * Anchoring a sheet to the bottom edge is a phone idiom: it's within thumb
 * reach, and on a small screen the sheet is most of the screen anyway. In a
 * 1700pt window the same thing spans the full width for a handful of rows and
 * drags the eye to the corner furthest from the pointer. A centred card puts
 * the content where the user is already looking and matches the shell's other
 * overlays.
 *
 * iOS/Android resolve NativeSheetTrue instead — a real draggable
 * UISheetPresentationController sheet (react-native-true-sheet).
 */
export function NativeSheet({ visible, onClose, children }: NativeSheetProps) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={s.host}>
        <Pressable style={s.scrim} onPress={onClose} />
        <View style={s.panel}>{children}</View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create((theme) => ({
  host: { flex: 1, alignItems: "center", justifyContent: "center" },
  scrim: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: theme.colors.overlay,
  },
  panel: {
    width: 460,
    maxWidth: "92%",
    maxHeight: "80%",
    overflow: "hidden",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.bgElevated,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 12,
    shadowColor: "#000",
    shadowOpacity: 0.35,
    shadowRadius: 30,
    shadowOffset: { width: 0, height: 12 },
  },
}));
