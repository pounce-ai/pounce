/**
 * Unistyles theme pair (light/dark) — canonical shape + non-mobile fallback.
 * Platform truth lives in unistyles-themes.android.ts (Material-You roles
 * resolved for BOTH schemes up front) and unistyles-themes.ios.ts (the same
 * UIKit PlatformColors for both themes — iOS adapts natively, so unistyles
 * theme switching is a visual no-op there by design).
 *
 * This base file is what TypeScript resolves (and what any non-ios/android
 * bundle would get): both themes reuse the platform-default T tokens. The
 * desktop app never imports this — it shims react-native-unistyles entirely
 * (desktop/src/shims/unistyles.ts).
 */
import type { ColorValue } from "react-native";
import { T, type ThemeColor } from "./theme";

export type AppThemeColors = Record<ThemeColor, ColorValue>;
export type AppTheme = { colors: AppThemeColors };
export type AppThemes = { light: AppTheme; dark: AppTheme };

export const themes: AppThemes = {
  light: { colors: { ...T } },
  dark: { colors: { ...T } },
};
