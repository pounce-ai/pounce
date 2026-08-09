/**
 * Named colour themes.
 *
 * The app used to have ONE palette per platform, drawn from the platform's own
 * semantic colours (UIKit labels on iOS, Material-You roles on Android, AppKit
 * NSColors on macOS). Every theme here is explicit hex instead, because that is
 * the only thing that can repaint: `PlatformColor("labelColor")` resolves
 * natively and cannot be overridden, so a themed app has to stop asking the OS
 * for its colours. Those semantic palettes still exist as the `light`/`dark`
 * entries in ui/unistyles-themes.* — see the note on THEMES below.
 *
 * A theme variant is authored as a SEED of four values (canvas, foreground,
 * accent, appearance); `makePalette` derives the surface ramp, lines and text
 * steps from it so the 25 roles stay internally consistent and a new theme is
 * a two-line addition. Status hues are shared — "danger" should not change
 * meaning because the user picked a green theme.
 *
 * Runtime type note: this module is imported by vitest, so it must stay free
 * of react-native runtime imports (type-only import below).
 */
import { alpha, mix, readableOn } from "./color";
import type { ThemeColor } from "./theme";

export type Appearance = "light" | "dark";

/** Palettes are plain strings; `ColorValue` widening happens where they are
 *  handed to unistyles (ui/unistyles-themes.*). */
export type Palette = Record<ThemeColor, string>;

export type PaletteSeed = {
  appearance: Appearance;
  /** The page fill everything else is derived from. */
  canvas: string;
  /** Full-strength label colour. */
  fg: string;
  /** Brand/selection colour for this theme. */
  accent: string;
};

/** Status hues per ground. The dark values are the ones the app has always
 *  shipped; the light ones are GitHub's light-mode set, which is tuned for
 *  exactly this job (the previous palette already borrowed its diff pair). */
const STATUS = {
  dark: {
    success: "#3fb950",
    warning: "#d29922",
    danger: "#f85149",
    info: "#58a6ff",
    diffAddFg: "#56d364",
    diffDelFg: "#f85149",
  },
  light: {
    success: "#1a7f37",
    warning: "#9a6700",
    danger: "#cf222e",
    info: "#0969da",
    diffAddFg: "#1a7f37",
    diffDelFg: "#cf222e",
  },
} as const;

/**
 * Derive a full 25-role palette from a seed.
 *
 * Surfaces step toward white on both grounds — on dark that lifts a card off
 * the page, and on light it does the same because the canvas is a faint grey
 * mat rather than paper (which is why `surfaceAlt` can land on pure white).
 * Lines step toward the FOREGROUND instead: a light theme needs its borders
 * darker than the page, and a dark theme needs them lighter, and "toward the
 * text colour" is the one rule that gets both right.
 */
export function makePalette(seed: PaletteSeed): Palette {
  const { appearance, canvas, fg, accent } = seed;
  const dark = appearance === "dark";
  const lift = (t: number) => mix(canvas, "#ffffff", t);
  const line = (t: number) => mix(canvas, fg, t);

  const surfaceAlt = dark ? lift(0.09) : lift(1);
  const status = STATUS[appearance];

  return {
    /* Backgrounds */
    bg: canvas,
    bgElevated: dark ? lift(0.035) : lift(0.55),
    surface: dark ? lift(0.055) : lift(0.8),
    surfaceAlt,
    surfaceHover: dark ? lift(0.13) : mix(surfaceAlt, fg, 0.06),

    /* Lines */
    border: line(dark ? 0.14 : 0.12),
    borderStrong: line(dark ? 0.28 : 0.26),

    /* Text — `fgProse` is running prose, stepped a touch off the full-strength
       label so a screenful doesn't glare. See the note in ui/theme.ts. */
    fg,
    fgProse: mix(fg, canvas, 0.12),
    fgMuted: mix(fg, canvas, 0.35),
    fgFaint: mix(fg, canvas, 0.52),
    onAccent: readableOn(accent),

    /* Brand + status */
    accent,
    accentSoft: alpha(accent, dark ? 0.15 : 0.1),
    accentLine: alpha(accent, 0.4),
    accentTint: alpha(accent, dark ? 0.06 : 0.05),
    success: status.success,
    warning: status.warning,
    danger: status.danger,
    info: status.info,
    successSoft: alpha(status.success, dark ? 0.15 : 0.12),
    warningSoft: alpha(status.warning, dark ? 0.15 : 0.12),
    dangerSoft: alpha(status.danger, dark ? 0.15 : 0.1),

    /* Scrims. Half-black over a light window is a blackout; the same value
       over a near-black one barely registers. */
    overlay: dark ? "rgba(0, 0, 0, 0.55)" : "rgba(0, 0, 0, 0.28)",

    /* Diff blocks */
    diffAddBg: alpha(status.diffAddFg, dark ? 0.15 : 0.13),
    diffDelBg: alpha(status.diffDelFg, dark ? 0.15 : 0.11),
    diffAddFg: status.diffAddFg,
    diffDelFg: status.diffDelFg,
  };
}

/**
 * The literal-hex subset consumers need when a `PlatformColor` can't flow —
 * navigation chrome, the native markdown renderer, prism, SVG charts. Mirrors
 * the shape of `HEX` in ui/theme-hex.ts.
 */
export type PaletteHex = {
  bg: string;
  bgElevated: string;
  fg: string;
  fgMuted: string;
  accent: string;
  /** Flattened mid-tone: SVG fills can't blend a translucent token reliably
   *  across renderers, so charts get a solid stand-in for `accentSoft`. */
  accentSoftSolid: string;
  border: string;
  /** The accent as READING material — inline code in a message, an accented
   *  label. The raw accent is tuned to be seen (a fill, a dot, a border), and
   *  set as small text it either glares on a dark ground or falls under the
   *  contrast floor on a light one; this is that same hue, stepped toward the
   *  ground's opposite until it reads. */
  accentInk: string;
  /** Translucent accent for the chip BEHIND that text. */
  accentWash: string;
};

/** See `accentInk`. Light grounds darken the hue, dark grounds lighten it. */
export const accentInk = (accent: string, appearance: Appearance): string =>
  appearance === "dark" ? mix(accent, "#ffffff", 0.35) : mix(accent, "#000000", 0.08);

/** See `accentWash`. */
export const accentWash = (accent: string, appearance: Appearance): string =>
  alpha(accent, appearance === "dark" ? 0.16 : 0.12);

const hexOf = (p: Palette, appearance: Appearance): PaletteHex => ({
  bg: p.bg,
  bgElevated: p.bgElevated,
  fg: p.fg,
  fgMuted: p.fgMuted,
  accent: p.accent,
  accentSoftSolid: mix(p.bg, p.accent, 0.45),
  border: p.border,
  accentInk: accentInk(p.accent, appearance),
  accentWash: accentWash(p.accent, appearance),
});

export type ThemeId = "pounce" | "grove" | "ocean" | "ember" | "mono";

export type ThemeDefinition = {
  id: ThemeId;
  label: string;
  /** One-line description shown under the name in the picker. */
  blurb: string;
  light: Palette;
  dark: Palette;
  hex: { light: PaletteHex; dark: PaletteHex };
};

const define = (
  id: ThemeId,
  label: string,
  blurb: string,
  seeds: { light: Omit<PaletteSeed, "appearance">; dark: Omit<PaletteSeed, "appearance"> },
): ThemeDefinition => {
  const light = makePalette({ appearance: "light", ...seeds.light });
  const dark = makePalette({ appearance: "dark", ...seeds.dark });
  return {
    id,
    label,
    blurb,
    light,
    dark,
    hex: { light: hexOf(light, "light"), dark: hexOf(dark, "dark") },
  };
};

/**
 * Ordered — this is the order the picker renders, and the first entry is the
 * default.
 *
 * There was a "System" theme here (the platform's own semantic colours: UIKit
 * labels, AppKit NSColors, Material You). It was dropped because on macOS and
 * iOS it was indistinguishable from Pounce — the palette had been tuned to
 * match the platform in the first place, so the picker offered the same look
 * twice. The machinery is still in place (`light`/`dark` in
 * ui/unistyles-themes.* are those semantic palettes, and stay registered as the
 * pre-hydration fallback), so bringing it back is a `define()` away — worth
 * knowing on ANDROID, where it was NOT a duplicate: Material You tints the
 * whole palette from the user's wallpaper, and that is now gone.
 */
export const THEMES: ReadonlyArray<ThemeDefinition> = [
  define("pounce", "Pounce", "The brand purple, identical on every platform", {
    light: { canvas: "#f6f6fa", fg: "#1c1c22", accent: "#5b4fd6" },
    dark: { canvas: "#0b0b0f", fg: "#ececf1", accent: "#7c6ff0" },
  }),
  define("grove", "Grove", "Warm greens over a paper-white page", {
    light: { canvas: "#f4f7f2", fg: "#17231a", accent: "#2f7d4f" },
    dark: { canvas: "#0c110d", fg: "#e6efe7", accent: "#4ec97f" },
  }),
  define("ocean", "Ocean", "Deep blues with a teal accent", {
    light: { canvas: "#f2f6fa", fg: "#152029", accent: "#0f7b8f" },
    dark: { canvas: "#0a1017", fg: "#e3edf5", accent: "#38b6cf" },
  }),
  define("ember", "Ember", "Low warm light, amber accent", {
    light: { canvas: "#faf5f1", fg: "#241a14", accent: "#b45309" },
    dark: { canvas: "#120d0a", fg: "#f1e6dd", accent: "#f59e42" },
  }),
  define("mono", "Mono", "Neutral greys, nothing competing for attention", {
    light: { canvas: "#f5f5f5", fg: "#1a1a1a", accent: "#4a4a4a" },
    dark: { canvas: "#0d0d0d", fg: "#ededed", accent: "#b4b4b4" },
  }),
];

export const THEME_IDS: ReadonlyArray<ThemeId> = THEMES.map((t) => t.id);

const BY_ID: Record<string, ThemeDefinition> = Object.fromEntries(THEMES.map((t) => [t.id, t]));

export const DEFAULT_THEME_ID: ThemeId = "pounce";

/** Unknown ids — a downgrade, a hand-edited store, or the retired `system`
 *  left in a store from an earlier build — fall back to the default. */
export function themeById(id: string | null | undefined): ThemeDefinition {
  return BY_ID[id ?? ""] ?? BY_ID[DEFAULT_THEME_ID];
}

export function isThemeId(id: string | null | undefined): id is ThemeId {
  return id != null && id in BY_ID;
}

/** Name of the registered unistyles theme for a (theme, scheme) pair. */
export function themeName(id: string | null | undefined, scheme: Appearance): string {
  return `${themeById(id).id}-${scheme}`;
}

/** The hex subset for a (theme, scheme) pair — see `PaletteHex`. */
export function hexForTheme(id: string | null | undefined, scheme: Appearance): PaletteHex {
  return themeById(id).hex[scheme];
}

/** Swatches shown in the picker: page, card, accent, text. */
export function previewSwatches(theme: ThemeDefinition, scheme: Appearance): string[] {
  const p = theme[scheme];
  return [p.bg, p.surfaceAlt, p.accent, p.fg];
}
