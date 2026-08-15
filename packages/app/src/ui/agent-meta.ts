/**
 * Per-agent composer metadata: which inputs an agent supports and the option
 * lists for each. Capabilities reported by the daemon win; these are sensible
 * fallbacks so controls still appear before a device has synced.
 */
import type { AgentCapabilities, PermissionMode } from "@pounce/shared";

export type ReasoningEffort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

const NO_CAPS: AgentCapabilities = {
  streaming: true,
  tools: false,
  images: false,
  thinking: false,
  terminal: false,
  git: false,
};

/** Best-effort defaults when a device hasn't reported capabilities yet. */
export const DEFAULT_CAPS: Record<string, AgentCapabilities> = {
  claude: { streaming: true, tools: true, images: true, thinking: true, terminal: true, git: true },
  codex: { streaming: true, tools: true, images: true, thinking: true, terminal: true, git: true },
  cursor: {
    streaming: true,
    tools: true,
    images: false,
    thinking: true,
    terminal: true,
    git: true,
  },
  opencode: {
    streaming: true,
    tools: true,
    images: false,
    thinking: false,
    terminal: true,
    git: true,
  },
};

export function effectiveCaps(
  agent: string,
  reported: AgentCapabilities | null,
): AgentCapabilities {
  // Merge, don't replace: devices report a transport-shaped capabilities object
  // that omits our UI keys (images, thinking, …), so overlay it on the static
  // defaults — reported values win where present, defaults fill the rest.
  const base = DEFAULT_CAPS[agent] ?? NO_CAPS;
  return reported ? { ...base, ...reported } : base;
}

export interface ModeOption {
  value: PermissionMode;
  label: string;
  hint: string;
}

/** Permission modes per agent. ≤1 entry → the mode control is hidden. */
export const AGENT_MODES: Record<string, ModeOption[]> = {
  claude: [
    { value: "default", label: "Default", hint: "Asks before edits" },
    { value: "plan", label: "Plan", hint: "Plan only — no changes" },
    { value: "acceptEdits", label: "Accept edits", hint: "Auto-apply edits" },
    { value: "bypassPermissions", label: "Full auto", hint: "No prompts" },
  ],
};

export function modesFor(agent: string): ModeOption[] {
  return AGENT_MODES[agent] ?? [];
}

export const REASONING_EFFORTS: { value: ReasoningEffort; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Max" },
];

/**
 * Fallback slash commands, for hosts too old to enumerate their agent's real
 * ones (best-effort text passthrough).
 *
 * Both transports report the true list — the composer prefers it via
 * fetchCommands() and only falls back here when the host answers `static`.
 * Every entry below is verified present on the stream-json transport, which is
 * what such a host runs; `/clear` is deliberately kept even though ACP refuses
 * it, because a host reaching this list is not on ACP.
 *
 * Don't grow this by hand. It was six entries for a long time, of which two
 * (`/help`, `/review`) existed on NEITHER transport and had been bouncing
 * silently — which is the argument against maintaining it as a guess at all.
 */
export const SLASH_COMMANDS: { cmd: string; desc: string; hint?: string }[] = [
  { cmd: "/clear", desc: "Clear context" },
  { cmd: "/compact", desc: "Compact the conversation" },
  { cmd: "/code-review", desc: "Review current changes" },
  { cmd: "/model", desc: "Switch model" },
  { cmd: "/init", desc: "Initialize project memory" },
];
