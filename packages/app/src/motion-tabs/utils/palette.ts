import type { IPalette } from "../typings/motion-tabs";

/**
 * Pounce is a dark-only app, so both schemes resolve to the same palette drawn
 * from the app's design tokens (src/ui/tokens.ts + global.css). `accent` is the
 * active-tab / hold-circle tint, not a solid fill.
 */
const POUNCE_DARK: IPalette = {
  foreground: "#ececf1",
  muted: "#9a9aa5",
  // Near-opaque: the morphing popup uses this as a backing so the thread list
  // behind the floating tab bar doesn't bleed through and wash it out.
  surface: "rgba(17,17,23,0.98)",
  border: "rgba(255,255,255,0.08)",
  input: "rgba(255,255,255,0.06)",
  hover: "rgba(255,255,255,0.08)",
  accent: "rgba(124,111,240,0.20)",
};

function palette<T extends "dark" | "light">(_scheme: T): IPalette {
  return POUNCE_DARK;
}

export { palette };
