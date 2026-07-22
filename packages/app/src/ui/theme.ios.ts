/**
 * iOS theme: UIKit semantic colors via expo-router's type-safe Color API —
 * the app follows the system light/dark appearance like a stock app. Brand
 * accent stays Pounce purple; translucent tints are precomputed rgba because
 * PlatformColor values can't be alpha-blended in JS.
 */
import { Color } from "expo-router";
import type { ColorValue } from "react-native";

const c = Color.ios;

export const T = {
  /* Backgrounds */
  // Grouped (not plain) system background: the faint gray page tint that iOS
  // settings-style lists use — gives the glass cards separation in light mode
  // (identical in dark).
  bg: c.systemGroupedBackground,
  bgElevated: c.secondarySystemBackground,
  surface: c.secondarySystemGroupedBackground,
  surfaceAlt: c.tertiarySystemFill,
  surfaceHover: c.quaternarySystemFill,

  /* Lines */
  border: c.separator,
  borderStrong: c.opaqueSeparator,

  /* Text */
  fg: c.label,
  fgMuted: c.secondaryLabel,
  // NOT tertiaryLabel: 12-13px metadata set in it is illegible on light
  // backgrounds; systemGray keeps AA-ish contrast in both schemes.
  fgFaint: c.systemGray,
  /** Text on accent-coloured fills — accent is fixed, so this is too. */
  onAccent: "#ffffff" as ColorValue,

  /* Brand + status */
  accent: "#7c6ff0" as ColorValue,
  accentSoft: "rgba(124, 111, 240, 0.15)" as ColorValue,
  success: c.systemGreen,
  warning: c.systemOrange,
  danger: c.systemRed,
  info: c.systemBlue,
  successSoft: "rgba(63, 185, 80, 0.15)" as ColorValue,
  warningSoft: "rgba(210, 153, 34, 0.15)" as ColorValue,
  dangerSoft: "rgba(248, 81, 73, 0.15)" as ColorValue,

  /* Scrims */
  overlay: "rgba(0, 0, 0, 0.5)" as ColorValue,

  /* Diff blocks */
  diffAddBg: "rgba(63, 185, 80, 0.15)" as ColorValue,
  diffDelBg: "rgba(248, 81, 73, 0.15)" as ColorValue,
  diffAddFg: c.systemGreen,
  diffDelFg: c.systemRed,
} as const;

export type ThemeColor = keyof typeof T;
