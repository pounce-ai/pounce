/**
 * The active theme's literal-hex palette.
 *
 * Most of the app reads colours through unistyles (`theme.colors.x`), which
 * can carry a PlatformColor. Some consumers can't: navigation chrome resolved
 * by react-native-screens, the native markdown renderer, prism, SVG fills.
 * They used to call `hexFor(useColorScheme())` — a fixed table picked by
 * ground. This is the same thing, but it also follows the chosen theme.
 */
import { useCallback } from "react";
import { useColorScheme } from "react-native";
import { useSelector } from "@legendapp/state/react";
import { appearance$, theme$ } from "../state/appearance";
import { hexForTheme, type Appearance, type PaletteHex } from "./palettes";
import { agentHex } from "./tokens";

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

/**
 * A brand hue picker bound to the ground the app is painting on.
 *
 * `agentHex`'s `scheme` argument is the trap this closes: every caller has to
 * know that it means the APP's ground and not `useColorScheme()`'s system
 * trait, and two of the three got it wrong — a mark tuned for white rendered on
 * a dark window, and a chart legend swatch that disagreed with its own line.
 * A rule enforced by a repeated paragraph is a rule waiting to be missed, so
 * the ground stops being a parameter anyone outside this module passes.
 *
 * Returns a stable callback, so a list can resolve one picker and use it for
 * every row instead of subscribing per row.
 */
export function useAgentHex(): (agent: string, fallback?: string) => string | undefined {
  const ground = useGround();
  return useCallback(
    (agent: string, fallback?: string) => agentHex(agent, ground) ?? fallback,
    [ground],
  );
}
