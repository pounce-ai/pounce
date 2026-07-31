/**
 * Desktop/default theme (macOS/Windows — iOS and Android have their own
 * platform files using expo-router's Color API, which the desktop bundle must
 * never import because expo-router is shimmed there). macOS resolves AppKit
 * semantic NSColors so the desktop app also follows the system appearance;
 * Windows keeps the legacy fixed dark palette for now.
 *
 * Two kinds of colour live here:
 *
 *   `mac(...)`  an AppKit semantic colour. It already knows both appearances,
 *               so prefer it whenever one exists with the right MEANING — the
 *               meaning is what makes it adapt correctly, and borrowing a
 *               nearly-right one (a selection tint used as a card fill, a page
 *               mat used as a raised surface) is how a palette ends up looking
 *               fine in dark and muddy in light.
 *
 *   `dual(...)` an explicit light/dark pair, for anything AppKit has no name
 *               for: the brand accent and the translucent tints built from it.
 *               A single fixed hex CANNOT work for both grounds — #7c6ff0 is
 *               right on near-black and only ~3.6:1 on white, which is below
 *               the readability floor for the label text it's used on.
 */
import * as RN from "react-native";
import { Platform, PlatformColor, type ColorValue } from "react-native";

const mac = (name: string, fallback: string): ColorValue =>
  Platform.OS === "macos" ? PlatformColor(name) : fallback;

/** react-native-macos exports this; the mobile package's types don't declare
 *  it, and this file is shared with them — hence the guarded lookup rather
 *  than a named import that would fail to typecheck on the phone builds. */
const dynamicMac = (
  RN as unknown as {
    DynamicColorMacOS?: (t: { light: string; dark: string }) => ColorValue;
  }
).DynamicColorMacOS;

/** Explicit light/dark pair. Off macOS there is no dynamic colour, and the
 *  Windows build is dark-only, so it resolves to the dark value. */
const dual = (light: string, dark: string): ColorValue =>
  Platform.OS === "macos" && dynamicMac ? dynamicMac({ light, dark }) : dark;

export const T = {
  /* Backgrounds */
  bg: mac("windowBackgroundColor", "#0b0b0f"),
  // Raised above `bg`: modal cards, sheets, the sidebar's opaque fallback. NOT
  // underPageBackgroundColor — that's the dark mat AppKit paints *beneath* a
  // page (Preview's grey surround), which read fine in dark and turned every
  // card into a grey slab in light.
  bgElevated: mac("controlBackgroundColor", "#101016"),
  // Field and control fills. White-on-white in light is intentional: macOS
  // delineates inset controls with a border, not a fill, and every input and
  // chip in the app draws one.
  surface: mac("controlBackgroundColor", "#141419"),
  // Card fill. Explicitly NOT unemphasizedSelectedContentBackgroundColor, which
  // is the colour of an unfocused *selection* — as a card fill it tinted every
  // panel in the dashboard a muddy blue-grey in light mode.
  surfaceAlt: dual("#ffffff", "#1b1b22"),
  surfaceHover: dual("#ececf1", "#23232c"),

  /* Lines */
  border: mac("separatorColor", "#26262f"),
  // gridColor is a table rule — almost invisible on a light window, which made
  // every "strong" border weaker than the plain one.
  borderStrong: dual("#d5d5dd", "#3a3a45"),

  /* Text. The label hierarchy adapts per appearance; systemGrayColor is the
     same grey on both grounds and skips it. */
  fg: mac("labelColor", "#ececf1"),
  fgMuted: mac("secondaryLabelColor", "#9a9aa5"),
  fgFaint: mac("tertiaryLabelColor", "#62626d"),
  onAccent: "#ffffff" as ColorValue,

  /* Brand + status */
  accent: dual("#5b4fd6", "#7c6ff0"),
  accentSoft: dual("rgba(91, 79, 214, 0.10)", "rgba(124, 111, 240, 0.15)"),
  success: mac("systemGreenColor", "#3fb950"),
  warning: mac("systemOrangeColor", "#d29922"),
  danger: mac("systemRedColor", "#f85149"),
  info: mac("systemBlueColor", "#58a6ff"),
  successSoft: dual("rgba(26, 127, 55, 0.12)", "rgba(63, 185, 80, 0.15)"),
  warningSoft: dual("rgba(154, 103, 0, 0.12)", "rgba(210, 153, 34, 0.15)"),
  dangerSoft: dual("rgba(207, 34, 46, 0.10)", "rgba(248, 81, 73, 0.15)"),

  /* Scrims. Half-black over a light window is a blackout; the same value over
     a near-black one barely registers. */
  overlay: dual("rgba(0, 0, 0, 0.28)", "rgba(0, 0, 0, 0.55)"),

  /* Diff blocks — GitHub's light-mode diff pair, which is tuned for exactly
     this job, and the existing dark values. */
  diffAddBg: dual("rgba(26, 127, 55, 0.13)", "rgba(63, 185, 80, 0.15)"),
  diffDelBg: dual("rgba(207, 34, 46, 0.11)", "rgba(248, 81, 73, 0.15)"),
  diffAddFg: dual("#1a7f37", "#56d364"),
  diffDelFg: dual("#cf222e", "#f85149"),
} as const;

export type ThemeColor = keyof typeof T;
