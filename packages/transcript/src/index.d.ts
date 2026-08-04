/**
 * @pounce/transcript — normalize coding-agent session-transcript message bodies.
 * See index.js for the full rationale and per-agent tag taxonomy.
 */

export interface ParsedUserMessage {
  /** A slash command the user invoked, rendered as a chip. */
  command?: { name: string; args?: string };
  /** Captured stdout/stderr from a local command, collapsed to a note. */
  output?: { text: string; isError: boolean };
  /** The human-visible prose, with all wrapper noise removed. */
  text: string;
}

export interface AgentRules {
  /** Zero-value tags stripped everywhere (server + client). */
  noise: string[];
  /** Whole lines to drop (e.g. Codex's "# AGENTS.md instructions for …"). */
  dropLines?: RegExp[];
  /** Tags that map to a slash-command chip: the name tag and the args tag. */
  command?: { name: string; args: string };
  /** Tags whose content collapses to an output note. */
  output?: { stdout: string[]; stderr: string[] };
  /** Captured output that is really TUI chrome — dropped instead of shown. */
  dropOutput?: RegExp[];
  /** Presentation tags removed from the prose during a full parse. */
  present?: string[];
}

/** Per-agent rule registry (agents absent here fall back to safe passthrough). */
export declare const AGENT_RULES: Record<string, AgentRules>;

/**
 * Strip only zero-value plumbing (system reminders, Codex's injected context,
 * caveats, hooks) and ANSI, leaving presentation-bearing tags intact. Safe to
 * run at ingest so every client renders readable text.
 */
export declare function stripNoise(raw: string, agent?: string): string;

/** Normalize one raw user-message string into a renderable shape. */
export declare function parseUserMessage(raw: string, agent?: string): ParsedUserMessage;

/** True when a parsed user message carries nothing worth showing. */
export declare function isEmptyUserMessage(p: ParsedUserMessage): boolean;

/** Strip injected `<system-reminder>`s (and ANSI) from assistant text. */
export declare function cleanAssistantText(raw: string, agent?: string): string;
