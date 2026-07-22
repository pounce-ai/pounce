/**
 * iOS unistyles themes: BOTH themes carry the SAME UIKit PlatformColor tokens
 * from theme.ios.ts. iOS re-resolves semantic colors natively on appearance
 * changes (plus the PounceAppearance window override), so unistyles switching
 * themes here must not change a single pixel — that's the contract that keeps
 * iOS identical while Android gets real runtime palettes.
 */
import type { ColorValue } from "react-native";
import { T, type ThemeColor } from "./theme";

const colors: Record<ThemeColor, ColorValue> = { ...T };

export const themes = {
  light: { colors },
  dark: { colors },
};
