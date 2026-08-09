import { describe, expect, it } from "vitest";
import { contrast } from "./color";
import {
  DEFAULT_THEME_ID,
  THEMES,
  hexForTheme,
  isThemeId,
  themeById,
  themeName,
  type Appearance,
} from "./palettes";
import { HEX } from "./theme-hex";

/** The role vocabulary every palette must cover — kept as a literal list
 *  rather than derived from a palette so a role dropped by `makePalette`
 *  fails here instead of silently vanishing from the app. */
const ROLES = [
  "bg",
  "bgElevated",
  "surface",
  "surfaceAlt",
  "surfaceHover",
  "border",
  "borderStrong",
  "fg",
  "fgProse",
  "fgMuted",
  "fgFaint",
  "onAccent",
  "accent",
  "accentSoft",
  "accentLine",
  "accentTint",
  "success",
  "warning",
  "danger",
  "info",
  "successSoft",
  "warningSoft",
  "dangerSoft",
  "overlay",
  "diffAddBg",
  "diffDelBg",
  "diffAddFg",
  "diffDelFg",
] as const;

const SCHEMES: Appearance[] = ["light", "dark"];

describe("palettes", () => {
  it("defaults to the first theme in the list", () => {
    expect(THEMES[0]?.id).toBe(DEFAULT_THEME_ID);
  });

  it("gives every theme a unique id and label", () => {
    expect(new Set(THEMES.map((t) => t.id)).size).toBe(THEMES.length);
    expect(new Set(THEMES.map((t) => t.label)).size).toBe(THEMES.length);
  });

  for (const theme of THEMES) {
    for (const scheme of SCHEMES) {
      describe(`${theme.id} / ${scheme}`, () => {
        const palette = theme[scheme];

        it("defines every role as a colour string", () => {
          for (const role of ROLES) {
            expect(palette[role], role).toMatch(/^(#[0-9a-f]{6}|rgba\()/i);
          }
          expect(Object.keys(palette).sort()).toEqual([...ROLES].sort());
        });

        it("keeps body text readable on the page", () => {
          // AA for normal text. `fgProse` is stepped off `fg` deliberately, so
          // it is checked too — that step must not walk it under the floor.
          expect(contrast(palette.fg, palette.bg)).toBeGreaterThanOrEqual(4.5);
          expect(contrast(palette.fgProse, palette.bg)).toBeGreaterThanOrEqual(4.5);
          // Muted metadata is smaller but still has to be read.
          expect(contrast(palette.fgMuted, palette.bg)).toBeGreaterThanOrEqual(3);
        });

        it("keeps labels readable on accent fills and cards", () => {
          expect(contrast(palette.onAccent, palette.accent)).toBeGreaterThanOrEqual(3);
          expect(contrast(palette.fg, palette.surfaceAlt)).toBeGreaterThanOrEqual(4.5);
        });

        it("separates the surface ramp from the page", () => {
          expect(palette.surfaceAlt).not.toBe(palette.bg);
          expect(palette.border).not.toBe(palette.bg);
        });
      });
    }
  }
});

describe("themeName", () => {
  it("namespaces every theme by id", () => {
    expect(themeName("ocean", "dark")).toBe("ocean-dark");
    expect(themeName("ember", "light")).toBe("ember-light");
  });

  it("falls back to the default for unknown ids", () => {
    // "system" is one of these now: it shipped in an earlier build, so a store
    // written by it must not strand the app on a theme that no longer exists.
    for (const id of ["no-such-theme", "system", null, undefined]) {
      expect(themeName(id, "dark")).toBe(`${DEFAULT_THEME_ID}-dark`);
      expect(themeById(id).id).toBe(DEFAULT_THEME_ID);
    }
    expect(isThemeId("system")).toBe(false);
    expect(isThemeId("grove")).toBe(true);
  });
});

describe("hexForTheme", () => {
  it("matches each theme's own palette", () => {
    for (const theme of THEMES) {
      for (const scheme of SCHEMES) {
        const hex = hexForTheme(theme.id, scheme);
        expect(hex.bg).toBe(theme[scheme].bg);
        expect(hex.accent).toBe(theme[scheme].accent);
        expect(hex.accentSoftSolid).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });

  it("keeps the default theme's dark ground on the legacy chrome values", () => {
    // Navigation chrome and the native markdown renderer read these literals
    // from ui/theme-hex.ts before themes existed. The default theme's DARK
    // palette still matches them exactly, so the app most people see did not
    // shift when themes shipped. (Its light ground deliberately did: the page
    // is now a faint grey mat with white cards, which is what makes a card
    // read as raised.)
    const hex = hexForTheme(DEFAULT_THEME_ID, "dark");
    expect(hex.bg).toBe(HEX.dark.bg);
    expect(hex.fg).toBe(HEX.dark.fg);
    expect(hex.accent).toBe(HEX.dark.accent);
  });

  it("derives the accent-as-text values from each theme's own accent", () => {
    for (const theme of THEMES) {
      for (const scheme of SCHEMES) {
        const hex = hexForTheme(theme.id, scheme);
        // Inline code in a message is set in this — it has to be readable on
        // the page, which the raw accent often is not.
        expect(contrast(hex.accentInk, hex.bg), `${theme.id}/${scheme}`).toBeGreaterThanOrEqual(3);
        expect(hex.accentWash).toMatch(/^rgba\(/);
      }
    }
  });
});
