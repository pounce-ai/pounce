/**
 * Android theme: Material 3 dynamic colors (Material You — follows the user's
 * wallpaper + light/dark setting) via expo-router's Color API. NOTE (from the
 * Expo docs): dynamic colors resolve against the current theme only when the
 * consuming component re-renders on scheme changes — the root layout calls
 * useColorScheme() for this.
 */
import { Color } from "expo-router";
import type { ColorValue } from "react-native";

const d = Color.android.dynamic;

export const T = {
  /* Backgrounds */
  bg: d.background,
  bgElevated: d.surfaceContainerLow,
  surface: d.surfaceContainer,
  surfaceAlt: d.surfaceContainerHigh,
  surfaceHover: d.surfaceContainerHighest,

  /* Lines */
  border: d.outlineVariant,
  borderStrong: d.outline,

  /* Text */
  fg: d.onSurface,
  /** Long-form body text. Aliased to the platform's own label colour on
   *  purpose: iOS and Android already tune their semantic text colours for
   *  running text, and overriding them would fight the OS. Desktop draws its
   *  own chrome and has no such tuning, which is where this token earns its
   *  keep — see ui/theme.ts. */
  fgProse: d.onSurface,
  fgMuted: d.onSurfaceVariant,
  fgFaint: d.outline,
  onAccent: "#ffffff" as ColorValue,

  /* Brand + status (status hues have no Material dynamic equivalents) */
  accent: "#7c6ff0" as ColorValue,
  accentSoft: "rgba(124, 111, 240, 0.15)" as ColorValue,
  success: "#3fb950" as ColorValue,
  warning: "#d29922" as ColorValue,
  danger: d.error,
  info: "#58a6ff" as ColorValue,
  successSoft: "rgba(63, 185, 80, 0.15)" as ColorValue,
  warningSoft: "rgba(210, 153, 34, 0.15)" as ColorValue,
  dangerSoft: "rgba(248, 81, 73, 0.15)" as ColorValue,

  /* Scrims */
  overlay: "rgba(0, 0, 0, 0.5)" as ColorValue,

  /* Diff blocks */
  diffAddBg: "rgba(63, 185, 80, 0.15)" as ColorValue,
  diffDelBg: "rgba(248, 81, 73, 0.15)" as ColorValue,
  diffAddFg: "#3fb950" as ColorValue,
  diffDelFg: d.error,
} as const;

export type ThemeColor = keyof typeof T;
