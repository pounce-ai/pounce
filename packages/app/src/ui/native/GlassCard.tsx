import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { GlassCardProps } from "./glass";

export type { GlassCardProps } from "./glass";

/** Cross-platform default (Android/desktop/pre-26 iOS fallback): a plain
 *  grouped-surface card. The iOS variant renders real liquid glass. Unistyles
 *  theme function so Android surfaces repaint on runtime theme switches. */
export function GlassCard({ children, style, radius = 16, shadow }: GlassCardProps) {
  return (
    <View style={[s.card, { borderRadius: radius }, shadow && s.shadow, style]}>{children}</View>
  );
}

const s = StyleSheet.create((theme) => ({
  card: {
    backgroundColor: theme.colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
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
}));
