/**
 * Android unistyles themes: Material-You (Material 3 dynamic) role colors
 * resolved for BOTH schemes up front.
 *
 * Why not theme.android.ts's tokens: expo-router's Color.android.dynamic.*
 * calls Appearance.getColorScheme() AT ACCESS TIME and returns a concrete
 * color for that scheme — accessed once at module load, the boot palette is
 * frozen into every StyleSheet forever. The underlying native call
 * (ExpoRouter.Material3DynamicColor(name, scheme)) takes an EXPLICIT scheme,
 * so we resolve the light AND dark palettes eagerly and let unistyles swap
 * whole themes at runtime.
 *
 * Token mapping mirrors theme.android.ts exactly; the literal hex/rgba brand
 * and status tokens are copied verbatim from there.
 */
import type { ColorValue } from "react-native";
import { HEX } from "./theme-hex";
import type { ThemeColor } from "./theme";

type Scheme = "light" | "dark";
type ExpoRouterNative = {
  Material3DynamicColor(name: string, scheme: string): string | null;
};

let native: ExpoRouterNative | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { requireNativeModule } = require("expo-modules-core");
  native = requireNativeModule("ExpoRouter");
} catch {
  native = null; // Expo Go / tests — fall back to the static palettes below
}

/** Material 3 BASELINE role values (m3.material.io defaults) — used only when
 *  the native module is missing or a role lookup returns null, so the app
 *  still boots with a sane scheme-correct palette. Brand hexes come from
 *  theme-hex.ts to stay in sync with the header/sheet colors. */
const BASELINE: Record<Scheme, Record<string, string>> = {
  light: {
    background: "#fef7ff",
    surfaceContainerLow: "#f7f2fa",
    surfaceContainer: "#f3edf7",
    surfaceContainerHigh: "#ece6f0",
    surfaceContainerHighest: "#e6e0e9",
    outlineVariant: "#cac4d0",
    outline: "#79747e",
    onSurface: "#1d1b20",
    onSurfaceVariant: "#49454f",
    error: "#b3261e",
  },
  dark: {
    background: "#141218",
    surfaceContainerLow: "#1d1b20",
    surfaceContainer: "#211f26",
    surfaceContainerHigh: "#2b2930",
    surfaceContainerHighest: "#36343b",
    outlineVariant: "#49454f",
    outline: "#938f99",
    onSurface: "#e6e0e9",
    onSurfaceVariant: "#cac4d0",
    error: "#f2b8b5",
  },
};

let warned = false;
const role = (name: string, scheme: Scheme): ColorValue => {
  const resolved = native?.Material3DynamicColor(name, scheme);
  if (typeof resolved === "string" && resolved) return resolved;
  if (__DEV__ && !warned) {
    warned = true;
    console.warn(
      `[unistyles-themes] ExpoRouter.Material3DynamicColor unavailable for "${name}"/${scheme} — using baseline M3 palette`,
    );
  }
  return BASELINE[scheme][name] ?? HEX[scheme].bg;
};

const colors = (scheme: Scheme): Record<ThemeColor, ColorValue> => ({
  /* Backgrounds */
  bg: role("background", scheme),
  bgElevated: role("surfaceContainerLow", scheme),
  surface: role("surfaceContainer", scheme),
  surfaceAlt: role("surfaceContainerHigh", scheme),
  surfaceHover: role("surfaceContainerHighest", scheme),

  /* Lines */
  border: role("outlineVariant", scheme),
  borderStrong: role("outline", scheme),

  /* Text */
  fg: role("onSurface", scheme),
  fgMuted: role("onSurfaceVariant", scheme),
  fgFaint: role("outline", scheme),
  onAccent: "#ffffff",

  /* Brand + status (status hues have no Material dynamic equivalents) */
  accent: "#7c6ff0",
  accentSoft: "rgba(124, 111, 240, 0.15)",
  success: "#3fb950",
  warning: "#d29922",
  danger: role("error", scheme),
  info: "#58a6ff",
  successSoft: "rgba(63, 185, 80, 0.15)",
  warningSoft: "rgba(210, 153, 34, 0.15)",
  dangerSoft: "rgba(248, 81, 73, 0.15)",

  /* Scrims */
  overlay: "rgba(0, 0, 0, 0.5)",

  /* Diff blocks */
  diffAddBg: "rgba(63, 185, 80, 0.15)",
  diffDelBg: "rgba(248, 81, 73, 0.15)",
  diffAddFg: "#3fb950",
  diffDelFg: role("error", scheme),
});

export const themes = {
  light: { colors: colors("light") },
  dark: { colors: colors("dark") },
};
