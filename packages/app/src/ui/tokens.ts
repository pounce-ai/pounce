/**
 * Plain (non-component) UI tokens. Lives apart from index.tsx so leaf modules
 * like AgentLogo.tsx can import these without a circular dependency.
 */

import { T } from "./theme";

/** Semantic color tokens (platform-adaptive — see theme.ts). Kept under the
 *  COLOR name so existing call sites keep working. */
export const COLOR = {
  /** The page fill. Needed by the few Reanimated-managed views that have to
   *  cover content: those can't take a unistyles sheet entry, and deriving a
   *  hex from `useColorScheme()` instead desyncs from this palette the moment
   *  the in-app appearance override disagrees with the system trait. */
  bg: T.bg,
  accent: T.accent,
  fg: T.fg,
  fgMuted: T.fgMuted,
  fgFaint: T.fgFaint,
  success: T.success,
  warning: T.warning,
  danger: T.danger,
} as const;

/** Human-facing agent names (brands keep their own casing). */
export const AGENT_LABEL: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "opencode",
  pi: "Pi",
  amp: "Amp",
  droid: "Droid",
  devin: "Devin",
  grok: "Grok",
  hermes: "Hermes",
};

/** Brand color per agent as a hex string (for icons / non-className use). */
/**
 * Brand hues for agent marks, tuned for a DARK ground.
 *
 * These are plain strings because they end up as SVG fills, where a
 * PlatformColor can't flow — so unlike the semantic palette in ui/theme.ts they
 * can't adapt on their own, and several are unusable on white. Codex's mark is
 * #ECECF1: correct on near-black, invisible on a light window. Read them
 * through `agentHex()` rather than directly.
 */
export const AGENT_HEX: Record<string, string> = {
  claude: "#D97757",
  codex: "#ECECF1",
  cursor: "#CBD5E1",
  opencode: "#58A6FF",
  pi: "#3FB950",
  amp: "#D29922",
  droid: "#5EC8C8",
  devin: "#9D7BF4",
  grok: "#9A9AA5",
  hermes: "#7C6FF0",
};

/**
 * Light-ground overrides. Only for marks the dark hue can't serve: the
 * monochrome ones (Codex, Cursor, Grok all ship a black mark for light
 * backgrounds, which is what these are) and the bright accents that fall under
 * ~3:1 on white. Claude's terracotta is absent deliberately — Anthropic uses
 * the same hue on both grounds.
 */
const AGENT_HEX_LIGHT: Record<string, string> = {
  codex: "#0D0D0D",
  cursor: "#1F2937",
  grok: "#111827",
  opencode: "#1D4ED8",
  pi: "#1A7F37",
  amp: "#9A6700",
  droid: "#177E7E",
  devin: "#6D4EE0",
  hermes: "#5B4FD6",
};

/** Brand hue for an agent on the given ground. Pass `useColorScheme()`. */
// `scheme` is widened to a plain string: RN's ColorSchemeName differs between
// the mobile and macOS type packages, and this file is shared by both.
export function agentHex(agent: string, scheme: string | null | undefined): string | undefined {
  if (scheme === "light") return AGENT_HEX_LIGHT[agent] ?? AGENT_HEX[agent];
  return AGENT_HEX[agent];
}

export function agentLabel(agent: string): string {
  return AGENT_LABEL[agent] ?? agent;
}

/**
 * Search-match highlight — the lime used wherever the app says "this is the bit
 * you were looking for": the deep-linked message in a thread, and matched
 * passages in the project-context reader. Deliberately outside the light/dark
 * theme: it has to stay legible against both, and it means "found", not "brand".
 */
export const HIGHLIGHT = "#B3E561";
/** The same colour as a wash behind matched text. */
export const HIGHLIGHT_BG = "rgba(179, 229, 97, 0.22)";

/**
 * Type scale for text that ISN'T a conversation turn — a carried-over
 * compaction summary, reference material, anything the reader should clock as
 * secondary before they read a word of it. Lives here because both markdown
 * renderers (native md4c on mobile, the hand-rolled one on desktop) need it.
 */
export const SECONDARY_SCALE = 0.85;
