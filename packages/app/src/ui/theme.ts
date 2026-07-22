/**
 * Desktop/default theme (macOS/Windows — iOS and Android have their own
 * platform files using expo-router's Color API, which the desktop bundle must
 * never import because expo-router is shimmed there). macOS resolves AppKit
 * semantic NSColors so the desktop app also follows the system appearance;
 * Windows keeps the legacy fixed dark palette for now.
 */
import { Platform, PlatformColor, type ColorValue } from "react-native";

const mac = (name: string, fallback: string): ColorValue =>
  Platform.OS === "macos" ? PlatformColor(name) : fallback;

export const T = {
  /* Backgrounds */
  bg: mac("windowBackgroundColor", "#0b0b0f"),
  bgElevated: mac("underPageBackgroundColor", "#101016"),
  surface: mac("controlBackgroundColor", "#141419"),
  surfaceAlt: mac("unemphasizedSelectedContentBackgroundColor", "#1b1b22"),
  surfaceHover: mac("unemphasizedSelectedContentBackgroundColor", "#23232c"),

  /* Lines */
  border: mac("separatorColor", "#26262f"),
  borderStrong: mac("gridColor", "#33333e"),

  /* Text */
  fg: mac("labelColor", "#ececf1"),
  fgMuted: mac("secondaryLabelColor", "#9a9aa5"),
  fgFaint: mac("systemGrayColor", "#62626d"),
  onAccent: "#ffffff" as ColorValue,

  /* Brand + status */
  accent: "#7c6ff0" as ColorValue,
  accentSoft: "rgba(124, 111, 240, 0.15)" as ColorValue,
  success: mac("systemGreenColor", "#3fb950"),
  warning: mac("systemOrangeColor", "#d29922"),
  danger: mac("systemRedColor", "#f85149"),
  info: mac("systemBlueColor", "#58a6ff"),
  successSoft: "rgba(63, 185, 80, 0.15)" as ColorValue,
  warningSoft: "rgba(210, 153, 34, 0.15)" as ColorValue,
  dangerSoft: "rgba(248, 81, 73, 0.15)" as ColorValue,

  /* Scrims */
  overlay: "rgba(0, 0, 0, 0.5)" as ColorValue,

  /* Diff blocks */
  diffAddBg: "rgba(63, 185, 80, 0.15)" as ColorValue,
  diffDelBg: "rgba(248, 81, 73, 0.15)" as ColorValue,
  diffAddFg: mac("systemGreenColor", "#56d364"),
  diffDelFg: mac("systemRedColor", "#f85149"),
} as const;

export type ThemeColor = keyof typeof T;
