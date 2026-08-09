/**
 * The active theme's literal-hex palette.
 *
 * Most of the app reads colours through unistyles (`theme.colors.x`), which
 * can carry a PlatformColor. Some consumers can't: navigation chrome resolved
 * by react-native-screens, the native markdown renderer, prism, SVG fills.
 * They used to call `hexFor(useColorScheme())` — a fixed table picked by
 * ground. This is the same thing, but it also follows the chosen theme.
 */
import { useColorScheme } from "react-native";
import { useSelector } from "@legendapp/state/react";
import { appearance$, theme$ } from "../state/appearance";
import { hexForTheme, type Appearance, type PaletteHex } from "./palettes";

/** The ground the app is painting on, as a re-rendering hook. */
export function useGround(): Appearance {
  const mode = useSelector(() => appearance$.get());
  // Read the trait as well as the override: on the frame where the override is
  // still landing, this is what the native chrome is actually painting.
  const system = useColorScheme();
  return mode === "system" ? (system === "light" ? "light" : "dark") : mode;
}

export function useThemeHex(): PaletteHex {
  const id = useSelector(() => theme$.get());
  return hexForTheme(id, useGround());
}
