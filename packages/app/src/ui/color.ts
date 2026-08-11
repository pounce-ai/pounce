/**
 * Tiny sRGB helpers for building theme palettes (ui/palettes.ts) — mixing a
 * canvas toward white/black to derive a surface ramp, and checking that the
 * result stays readable.
 *
 * Deliberately hex-only: these run at module load to produce plain strings for
 * unistyles themes, so there is no place for a PlatformColor here.
 */

export type Rgb = { r: number; g: number; b: number };

const clamp255 = (n: number) => Math.max(0, Math.min(255, Math.round(n)));

/** Accepts `#rgb` and `#rrggbb`. Throws on anything else — palettes are
 *  authored by hand, so a typo should fail loudly at import, not paint grey. */
export function hexToRgb(hex: string): Rgb {
  const raw = hex.trim().replace(/^#/, "");
  const full =
    raw.length === 3
      ? raw
          .split("")
          .map((c) => c + c)
          .join("")
      : raw;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) throw new Error(`Not a hex color: ${hex}`);
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

function rgbToHex({ r, g, b }: Rgb): string {
  return `#${[r, g, b].map((n) => clamp255(n).toString(16).padStart(2, "0")).join("")}`;
}

/** Linear blend: `t` of 0 keeps `from`, 1 becomes `to`. */
export function mix(from: string, to: string, t: number): string {
  const a = hexToRgb(from);
  const b = hexToRgb(to);
  return rgbToHex({
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  });
}

/** `rgba()` string for a hex colour at the given alpha — the form the app's
 *  translucent tints already use (accentSoft, diff washes, scrims). */
export function alpha(hex: string, a: number): string {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

const channelLuminance = (c: number) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};

/** WCAG relative luminance. */
export function luminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

/** WCAG contrast ratio, 1 (identical) to 21 (black on white). */
export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Black or white — whichever reads better on `background`. Used for the text
 *  drawn on accent fills, which differs per theme (white on deep purple,
 *  near-black on a bright amber). */
export function readableOn(background: string): string {
  return contrast(background, "#ffffff") >= contrast(background, "#111111") ? "#ffffff" : "#111111";
}
