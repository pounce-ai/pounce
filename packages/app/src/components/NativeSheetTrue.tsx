import { useEffect, useRef } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { TrueSheet } from "@lodev09/react-native-true-sheet";
import { useThemeHex } from "../ui/useThemeHex";
import type { NativeSheetProps } from "./NativeSheet";

/** iOS/Android: a REAL system sheet (UISheetPresentationController /
 *  BottomSheetDialog via react-native-true-sheet) — draggable, native grabber,
 *  auto-sized to content. Referenced only from NativeSheet.ios/.android so the
 *  desktop bundle never resolves the native lib. */
export function NativeSheet({ visible, onClose, children }: NativeSheetProps) {
  const ref = useRef<TrueSheet>(null);
  // Distinguish drag-to-dismiss (report onClose) from programmatic dismissal
  // (visible already false — reporting again would loop the owner's state).
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  useEffect(() => {
    if (visible) void ref.current?.present().catch(() => {});
    else void ref.current?.dismiss().catch(() => {});
  }, [visible]);
  // Scheme-picked hex, not a PlatformColor: the sheet's background resolves
  // against the presented VC's traits, which ignore the forced light/dark
  // toggle (same trap as navigation-bar colors).
  const hex = useThemeHex();
  return (
    <TrueSheet
      ref={ref}
      detents={["auto"]}
      dimmed
      cornerRadius={24}
      backgroundColor={hex.bgElevated}
      onDidDismiss={() => {
        if (visibleRef.current) onClose();
      }}
    >
      <View style={[s.content, s.contentPad]}>{children}</View>
    </TrueSheet>
  );
}

const s = StyleSheet.create((theme, rt) => ({
  /** Safe-area padding in the sheet — applied natively, no re-render. */
  contentPad: { paddingBottom: rt.insets.bottom + 16 },
  content: { paddingHorizontal: 16, paddingTop: 16 },
}));
