/**
 * Literal hex palettes for the few consumers that require STRING colors
 * (native libs like react-native-enriched-markdown, prism themes) where
 * PlatformColor's OpaqueColorValue can't flow. Pick by useColorScheme().
 */
export const HEX = {
  light: {
    bg: "#ffffff",
    bgElevated: "#f2f2f7",
    fg: "#1c1c1e",
    fgMuted: "#6e6e73",
    accent: "#7c6ff0",
    // SVG fills can't blend a translucent token reliably across renderers, so
    // the chart palette keeps flattened mid-tones instead of alpha.
    accentSoftSolid: "#c9c1f8",
    border: "#e5e5ea",
  },
  dark: {
    bg: "#0b0b0f",
    bgElevated: "#141419",
    fg: "#ececf1",
    fgMuted: "#9a9aa5",
    accent: "#7c6ff0",
    accentSoftSolid: "#4a3f9e",
    border: "#26262e",
  },
} as const;

export type HexScheme = keyof typeof HEX;

export const hexFor = (scheme: string | null | undefined) =>
  HEX[scheme === "light" ? "light" : "dark"];
