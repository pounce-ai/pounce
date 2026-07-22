/**
 * Plain (non-component) UI tokens. Lives apart from index.tsx so leaf modules
 * like agent-logos.tsx can import these without a circular dependency.
 */

import { T } from "./theme";

/** Semantic color tokens (platform-adaptive — see theme.ts). Kept under the
 *  COLOR name so existing call sites keep working. */
export const COLOR = {
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

export function agentLabel(agent: string): string {
  return AGENT_LABEL[agent] ?? agent;
}
