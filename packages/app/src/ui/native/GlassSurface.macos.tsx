import { requireNativeComponent, UIManager, View, type ViewProps } from "react-native";
import { T } from "../theme";
import type { GlassMaterial, GlassSurfaceProps } from "./glass";

export type { GlassMaterial, GlassSurfaceProps } from "./glass";

type NativeGlassProps = ViewProps & {
  material?: GlassMaterial;
  blendingMode?: "behindWindow" | "withinWindow";
  cornerRadius?: number;
};

// Guarded: an app binary built before PounceGlass was added (or a Windows
// bundle mis-resolved here) has no view manager — fall back to a flat surface
// instead of redboxing.
const NativeGlass =
  typeof UIManager.hasViewManagerConfig === "function" &&
  UIManager.hasViewManagerConfig("PounceGlassView")
    ? requireNativeComponent<NativeGlassProps>("PounceGlassView")
    : null;

export const hasNativeGlass = NativeGlass != null;

/** macOS: real NSVisualEffectView vibrancy (PounceGlass.mm). Children render
 *  above the blur; layout is ordinary Yoga. Pass only layout styles — paint
 *  props (backgroundColor/border) belong on overlays, not the native view. */
export function GlassSurface({
  children,
  style,
  material = "sidebar",
  blendingMode = "behindWindow",
  cornerRadius,
  fallbackColor,
}: GlassSurfaceProps) {
  if (!NativeGlass) {
    return (
      <View
        style={[
          { backgroundColor: fallbackColor ?? T.bgElevated, borderRadius: cornerRadius },
          style,
        ]}
      >
        {children}
      </View>
    );
  }
  return (
    <NativeGlass
      material={material}
      blendingMode={blendingMode}
      cornerRadius={cornerRadius}
      style={style}
    >
      {children}
    </NativeGlass>
  );
}
