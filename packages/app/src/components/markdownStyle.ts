/**
 * Markdown styling for the native md4c renderer, shared by every platform.
 *
 * Extracted from MessageMarkdown so the desktop variant renders identically
 * rather than carrying a second opinion about what a heading or an inline code
 * chip looks like — the two drifted once already, when the user bubble stopped
 * being accent-filled and only one of them was updated.
 *
 * Pure builders: they take the ground and the literal-hex palette as arguments
 * and call no hooks, so a caller can run them inside a `useMemo`.
 */
import type { MarkdownStyle, Md4cFlags } from "react-native-enriched-markdown";
import type { PaletteHex } from "../ui/palettes";

/** The one monospace face the app ships. */
export const MONO = "JetBrainsMono";

/** latex on for the assistant's math; underline/sub/superscript off so prose
 *  like a__b or ~n isn't reinterpreted. GFM strikethrough comes from
 *  flavor="github". */
export const MD4C_FLAGS: Md4cFlags = {
  underline: false,
  latexMath: true,
  superscript: false,
  subscript: false,
  highlight: false,
};

/** Markdown styling mapped onto Pounce tokens. The native engine requires
 *  STRING colors, so the styles are built per color scheme from the literal hex
 *  palette (never at module scope) — memoized per scheme and theme below. The
 *  palette arrives as an argument rather than a hook call: these are plain
 *  builders, run inside a useMemo. */
export function buildAssistantStyle(
  scheme: string | null | undefined,
  hex: PaletteHex,
): MarkdownStyle {
  const light = scheme === "light";
  return {
    paragraph: { fontSize: 15, lineHeight: 21, color: hex.fg, marginTop: 0, marginBottom: 6 },
    h1: { fontSize: 20, fontWeight: "700", color: hex.fg, marginTop: 2, marginBottom: 6 },
    h2: { fontSize: 18, fontWeight: "700", color: hex.fg, marginTop: 2, marginBottom: 6 },
    h3: { fontSize: 16, fontWeight: "700", color: hex.fg, marginTop: 2, marginBottom: 4 },
    h4: { fontSize: 15, fontWeight: "600", color: hex.fg, marginTop: 2, marginBottom: 4 },
    h5: { fontSize: 15, fontWeight: "600", color: hex.fgMuted, marginTop: 2, marginBottom: 2 },
    h6: { fontSize: 14, fontWeight: "600", color: hex.fgMuted, marginTop: 2, marginBottom: 2 },
    strong: { fontWeight: "bold", color: hex.fg },
    em: { fontStyle: "italic", color: hex.fg },
    strikethrough: { color: hex.fgMuted },
    link: { color: hex.accent, underline: false },
    // Accent chip so inline code pops out of prose — the enriched default
    // gives inline code a pink border, so pin the border to the fill to hide
    // it. Both come from the ACTIVE theme's accent (see `accentInk` in
    // ui/palettes.ts): this used to be the brand purple hardcoded, which left
    // a violet chip sitting in the middle of a green or amber theme.
    code: {
      fontFamily: MONO,
      fontSize: 13.5,
      color: hex.accentInk,
      backgroundColor: hex.accentWash,
      borderColor: hex.accentWash,
    },
    codeBlock: light
      ? {
          fontFamily: MONO,
          fontSize: 13,
          color: "#24292e",
          backgroundColor: "#f6f8fa",
          borderColor: "#e1e4e8",
          borderWidth: 1,
          borderRadius: 10,
          padding: 10,
        }
      : {
          fontFamily: MONO,
          fontSize: 13,
          color: "#cdd0d6",
          backgroundColor: "#0d0d12",
          borderColor: "#26262f",
          borderWidth: 1,
          borderRadius: 10,
          padding: 10,
        },
    blockquote: {
      color: hex.fgMuted,
      borderColor: light ? "#d0d0d7" : "#33333e",
      borderWidth: 3,
      gapWidth: 10,
      backgroundColor: "transparent",
    },
    // list.color defaults to a light-theme color — set it for both schemes.
    list: { color: hex.fg, bulletColor: hex.fgMuted, markerColor: hex.fgMuted, gapWidth: 8 },
    // Table defaults are light-theme (white bg / near-black text) — theme both.
    table: light
      ? {
          color: hex.fg,
          headerBackgroundColor: "#f2f2f6",
          headerTextColor: hex.fg,
          rowEvenBackgroundColor: "#ffffff",
          rowOddBackgroundColor: "#fafafc",
          borderColor: "#e1e4e8",
          borderWidth: 1,
          borderRadius: 8,
        }
      : {
          color: hex.fg,
          headerBackgroundColor: "#1b1b22",
          headerTextColor: hex.fg,
          rowEvenBackgroundColor: "#141419",
          rowOddBackgroundColor: "#101016",
          borderColor: "#2b2b35",
          borderWidth: 1,
          borderRadius: 8,
        },
    thematicBreak: {
      color: light ? "#e5e5ea" : "#26262f",
      height: 1,
      marginTop: 8,
      marginBottom: 8,
    },
  };
}

/**
 * Same, on the user bubble.
 *
 * The bubble used to be painted in the brand accent, so every token in here was
 * forced to white to survive it. It is now a neutral elevated surface — the
 * same weight as a code card — which means the user's own words no longer need
 * to shout over a saturated background, and the accent is free for things that
 * are actually actionable. So this is the assistant palette with only the two
 * things that genuinely differ on a raised surface: inset fills need to read
 * against `bgElevated` rather than the page, so they step DOWN to the page
 * colour instead of up.
 */
export function buildUserStyle(scheme: string | null | undefined, hex: PaletteHex): MarkdownStyle {
  const assistant = buildAssistantStyle(scheme, hex);
  const light = scheme === "light";
  return {
    ...assistant,
    paragraph: { fontSize: 15, lineHeight: 21, color: hex.fg, marginTop: 0, marginBottom: 4 },
    // Inline code sits ON the bubble, so it takes the page colour to read as an
    // inset; against the assistant's own code fill it would disappear.
    code: {
      fontFamily: MONO,
      fontSize: 13.5,
      color: light ? "#1f2328" : "#cdd0d6",
      backgroundColor: hex.bg,
      borderColor: hex.border,
    },
  };
}

/** Uniformly scale every font size and line height — see SECONDARY_SCALE. */
export function scaleStyle(style: MarkdownStyle, scale: number): MarkdownStyle {
  if (scale === 1) return style;
  const round = (n: number) => Math.round(n * scale * 10) / 10;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(style)) {
    if (!value || typeof value !== "object") {
      out[key] = value;
      continue;
    }
    const entry: Record<string, unknown> = { ...(value as Record<string, unknown>) };
    if (typeof entry.fontSize === "number") entry.fontSize = round(entry.fontSize);
    if (typeof entry.lineHeight === "number") entry.lineHeight = round(entry.lineHeight);
    out[key] = entry;
  }
  return out as MarkdownStyle;
}
