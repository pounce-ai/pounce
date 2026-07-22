import { View } from "react-native";
import { useUnistyles } from "react-native-unistyles";
import type { GlassSurfaceProps } from "./glass";

export type { GlassMaterial, GlassSurfaceProps } from "./glass";

/** True when the PounceGlassView native component is registered (macOS with a
 *  current binary); the .macos platform file overrides this. */
export const hasNativeGlass = false;

/** Cross-platform fallback: an opaque surface — desktop Windows and mobile
 *  land here, macOS resolves GlassSurface.macos.tsx (real NSVisualEffectView
 *  vibrancy). */
export function GlassSurface({ children, style, cornerRadius, fallbackColor }: GlassSurfaceProps) {
  const { theme } = useUnistyles();
  return (
    <View
      style={[
        { backgroundColor: fallbackColor ?? theme.colors.bgElevated, borderRadius: cornerRadius },
        style,
      ]}
    >
      {children}
    </View>
  );
}
