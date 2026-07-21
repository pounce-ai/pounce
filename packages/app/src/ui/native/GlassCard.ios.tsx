import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import type { GlassCardProps } from "./GlassCard";

const hasGlass = isLiquidGlassAvailable();

/** iOS: real liquid glass card (iOS 26+); regular material keeps content
 *  legible over any background. Pre-26 devices get the flat grouped surface. */
export function GlassCard({ children, style, radius = 16, interactive, shadow }: GlassCardProps) {
  if (!hasGlass) {
    return (
      <View style={[s.fallback, { borderRadius: radius }, shadow && s.shadow, style]}>
        {children}
      </View>
    );
  }
  return (
    <GlassView
      glassEffectStyle="regular"
      isInteractive={interactive}
      // Shadowed cards drop overflow:hidden — a layer shadow can't escape a
      // clipping bounds. The glass itself still rounds via layer cornerRadius;
      // children here have transparent backgrounds, so nothing pokes out.
      style={[shadow ? s.shadow : s.glass, { borderRadius: radius }, style]}
    >
      {children}
    </GlassView>
  );
}

const s = StyleSheet.create((theme) => ({
  glass: { overflow: "hidden" },
  shadow: {
    shadowColor: "#000",
    shadowOpacity: 0.12,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
  fallback: {
    backgroundColor: theme.colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    overflow: "hidden",
  },
}));
