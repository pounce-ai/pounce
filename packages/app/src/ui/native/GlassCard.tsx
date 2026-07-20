import type { ReactNode } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { T } from "../theme";

export interface GlassCardProps {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Corner radius of the card surface. */
  radius?: number;
  /** Interactive glass reacts to touches (iOS 26 only; ignored here). */
  interactive?: boolean;
  /** Soft drop shadow lifting the card off light backgrounds. */
  shadow?: boolean;
}

/** Cross-platform default (Android/desktop/pre-26 iOS fallback): a plain
 *  grouped-surface card. The iOS variant renders real liquid glass. */
export function GlassCard({ children, style, radius = 16, shadow }: GlassCardProps) {
  return (
    <View style={[s.card, { borderRadius: radius }, shadow && s.shadow, style]}>{children}</View>
  );
}

const s = StyleSheet.create({
  card: {
    backgroundColor: T.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: T.border,
    overflow: "hidden",
  },
  shadow: {
    // elevation is the Android shadow; the surface is opaque here so it works.
    elevation: 4,
    shadowColor: "#000",
    shadowOpacity: 0.1,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
});
