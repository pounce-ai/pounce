/**
 * Modal seam — desktop implementation.
 *
 * react-native-macos's native modal host (RCTModalHostView) crashes the app,
 * so sheets render as a plain absolute-fill overlay inside the current pane.
 * The children keep their own backdrop + bottom-sheet layout (a flex column
 * with a flex-1 backdrop works identically inside this container), and
 * animation/presentation props are accepted but ignored.
 */
import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";

export function Modal({
  visible,
  children,
}: {
  visible?: boolean;
  transparent?: boolean;
  animationType?: "none" | "slide" | "fade";
  presentationStyle?: string;
  onRequestClose?: () => void;
  children?: ReactNode;
}) {
  if (!visible) return null;
  return (
    <View style={[StyleSheet.absoluteFill, { zIndex: 1000, elevation: 1000 }]}>{children}</View>
  );
}
