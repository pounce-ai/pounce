/**
 * iOS unistyles themes: BOTH themes carry the SAME UIKit PlatformColor tokens
 * from theme.ios.ts. iOS re-resolves semantic colors natively on appearance
 * changes (plus the PounceAppearance window override), which is why both
 * entries can be the same object.
 *
 * Nothing SELECTS this pair any more — it is the pre-hydration fallback. Every
 * pickable theme (ui/palettes.ts) is explicit hex that deliberately replaces
 * the UIKit semantics, because a PlatformColor cannot be repainted.
 */
import type { ColorValue } from "react-native";
import { T, type ThemeColor } from "./theme";
import { NAMED_THEMES } from "./unistyles-named";

const colors: Record<ThemeColor, ColorValue> = { ...T };

export const themes = {
  light: { colors },
  dark: { colors },
  ...NAMED_THEMES,
};
