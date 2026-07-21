import { StyleSheet, View } from "react-native";
import { T } from "../theme";
import type { GlassCardProps } from "./glass";
import { GlassSurface, hasNativeGlass } from "./GlassSurface";

export type { GlassCardProps } from "./glass";

/** macOS: NSVisualEffectView vibrancy card (within-window popover material) —
 *  the desktop cousin of iOS liquid glass. The blur is an absolute-fill
 *  backdrop so only layout styles reach the native view; children stay in
 *  normal flow so the card still sizes to content. Falls back to the flat
 *  grouped surface when the native module is missing (stale binary). */
export function GlassCard({ children, style, radius = 16, shadow }: GlassCardProps) {
  if (!hasNativeGlass) {
    return (
      <View style={[s.fallback, { borderRadius: radius }, shadow && s.shadow, style]}>
        {children}
      </View>
    );
  }
  return (
    <View style={[{ borderRadius: radius }, shadow && s.shadow, style]}>
      <GlassSurface
        material="popover"
        blendingMode="withinWindow"
        cornerRadius={radius}
        style={StyleSheet.absoluteFill}
      />
      {/* No overflow:hidden here — the blur backdrop clips itself natively,
          and clipping children shaves content near the corner curves (project
          chip, composer send button). Mirrors the iOS variant's behavior. */}
      <View>{children}</View>
      <View pointerEvents="none" style={[s.borderOverlay, { borderRadius: radius }]} />
    </View>
  );
}

const s = StyleSheet.create({
  borderOverlay: {
    ...StyleSheet.absoluteFillObject,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: T.border,
  },
  shadow: {
    shadowColor: "#000",
    shadowOpacity: 0.12,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
  fallback: {
    backgroundColor: T.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: T.border,
    overflow: "hidden",
  },
});
