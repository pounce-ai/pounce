/**
 * @pounce/transcript — normalize coding-agent session-transcript message bodies.
 *
 * Coding-agent CLIs (Claude Code, Codex, opencode, …) each inline their own
 * agent-specific "plumbing" into message text — slash-command envelopes,
 * captured command output, injected project context, system reminders. Rendered
 * raw it looks like leaked internals. This module turns one raw message into a
 * small, presentable shape, keyed off which agent produced it.
 *
 * Two entry points, by consumer:
 *   - stripNoise(text, agent)      → remove only zero-value junk (system
 *                                    reminders, Codex's injected AGENTS.md, …)
 *                                    while PRESERVING presentation-bearing tags.
 *                                    Cheap and lossless enough to run server-side
 *                                    so every client gets clean text.
 *   - parseUserMessage(text, agent)→ full presentation parse: slash-command chip,
 *                                    collapsed output note, and cleaned prose.
 *                                    For the UI layer. Idempotent w.r.t. text
 *                                    that stripNoise already cleaned.
 *
 * SAFETY: real transcripts are full of legitimate `<…>` — code, HTML, TS
 * generics like `Array<string>`. So cleaning is a strict *allowlist* of known
 * envelope tag names per agent, never a blanket XML strip.
 *
 * Per-agent conventions (verified against real ~/.claude, ~/.codex,
 * ~/.local/share/opencode transcripts):
 *   claude   — <command-name|message|args>, <local-command-stdout|stderr>,
 *              <bash-input|stdout|stderr>, <system-reminder>,
 *              <local-command-caveat>, <user-prompt-submit-hook>
 *   codex    — injected leading context: <INSTRUCTIONS> (AGENTS.md),
 *              <environment_context>, <user_instructions>, and a
 *              "# AGENTS.md instructions for <path>" header line
 *   opencode — none; text parts are plain markdown → passthrough
 *   others   — unknown → passthrough (safe; nothing agent-specific stripped)
 */

// CSI (colors/cursor) and OSC (title) terminal escape sequences.
const ANSI_CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const ANSI_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** @param {string} s */
function stripAnsi(s) {
  return s.replace(ANSI_CSI, "").replace(ANSI_OSC, "");
}

/**
 * Remove every `<tag>…</tag>` block (tag from the allowlist) from `s`. The body
 * is a lazy match up to the matching close tag, so multi-paragraph envelopes
 * (Codex's AGENTS.md) strip cleanly. An *unclosed* tag simply fails to match —
 * it's left as-is rather than swallowing the rest of the message.
 * @param {string} s @param {string} name
 */
function stripTag(s, name) {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>[\\s\\S]*?</${name}>[ \\t]*\\n?`, "gi");
  return s.replace(re, "");
}

/** @param {string} s @param {string} name @returns {string | undefined} */
function extract(s, name) {
  const m = s.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? m[1] : undefined;
}

/**
 * @typedef {Object} AgentRules
 * @property {string[]} noise            Zero-value tags stripped everywhere (server + client).
 * @property {RegExp[]} [dropLines]      Whole lines to drop (e.g. Codex's AGENTS.md header).
 * @property {{ name: string, args: string }} [command]  Tags → slash-command chip.
 * @property {{ stdout: string[], stderr: string[] }} [output]  Tags → output note.
 * @property {string[]} [present]        Presentation tags removed from prose during full parse.
 */

/** @type {AgentRules} */
const CLAUDE = {
  // `task-notification` wraps a `<task-id>…</task-id>` block the harness injects
  // when a background task reports back — pure plumbing, never worth showing.
  noise: [
    "system-reminder",
    "local-command-caveat",
    "user-prompt-submit-hook",
    "command-message",
    "task-notification",
  ],
  command: { name: "command-name", args: "command-args" },
  output: {
    stdout: ["local-command-stdout", "bash-stdout"],
    stderr: ["local-command-stderr", "bash-stderr"],
  },
  present: [
    "command-name",
    "command-args",
    "local-command-stdout",
    "local-command-stderr",
    "bash-input",
    "bash-stdout",
    "bash-stderr",
  ],
};

/** @type {AgentRules} */
const CODEX = {
  noise: ["INSTRUCTIONS", "environment_context", "user_instructions", "system-reminder"],
  dropLines: [/^#\s*AGENTS\.md instructions for .+$/gim],
};

/** Agents with clean bodies (opencode) and unknown agents share this. @type {AgentRules} */
const BASE = { noise: [] };

/** @type {Record<string, AgentRules>} */
export const AGENT_RULES = { claude: CLAUDE, codex: CODEX };

/** @param {string} [agent] @returns {AgentRules} */
function rulesFor(agent) {
  return (agent && AGENT_RULES[agent]) || BASE;
}

/**
 * Strip only zero-value plumbing (system reminders, Codex's injected context,
 * caveats, hooks) and ANSI, leaving presentation-bearing tags intact. Safe to
 * run at ingest so every client renders readable text without reimplementing
 * the parser. Returns the cleaned string (trimmed).
 * @param {string} raw @param {string} [agent] @returns {string}
 */
export function stripNoise(raw, agent) {
  const rules = rulesFor(agent);
  let text = raw;
  for (const tag of rules.noise) text = stripTag(text, tag);
  for (const re of rules.dropLines ?? []) text = text.replace(re, "");
  return stripAnsi(text).trim();
}

/**
 * Normalize one raw user-message string into a renderable shape.
 * @param {string} raw @param {string} [agent]
 * @returns {import("./index").ParsedUserMessage}
 */
export function parseUserMessage(raw, agent) {
  const rules = rulesFor(agent);
  /** @type {import("./index").ParsedUserMessage["command"]} */
  let command;
  /** @type {import("./index").ParsedUserMessage["output"]} */
  let output;

  if (rules.command) {
    const name = extract(raw, rules.command.name)?.trim();
    if (name) {
      const args = extract(raw, rules.command.args)?.trim();
      command = { name, args: args || undefined };
    }
  }

  if (rules.output) {
    let stderr;
    for (const t of rules.output.stderr) {
      stderr = extract(raw, t);
      if (stderr != null) break;
    }
    let stdout;
    for (const t of rules.output.stdout) {
      stdout = extract(raw, t);
      if (stdout != null) break;
    }
    const captured = stderr ?? stdout;
    if (captured != null) {
      const text = stripAnsi(captured).trim();
      if (text) output = { text, isError: stderr != null };
    }
  }

  // Noise first (idempotent if the bridge already stripped it), then the
  // presentation tags we've already lifted into command/output above.
  let text = stripNoise(raw, agent);
  for (const tag of rules.present ?? []) text = stripTag(text, tag);
  text = text.trim();

  return { command, output, text };
}

/**
 * True when a parsed user message carries nothing worth showing — e.g. a lone
 * `<system-reminder>` or Codex's injected `<environment_context>`.
 * @param {import("./index").ParsedUserMessage} p
 */
export function isEmptyUserMessage(p) {
  return !p.command && !p.output && !p.text;
}

/**
 * Assistant text can carry the odd injected `<system-reminder>` too.
 * @param {string} raw @param {string} [agent] @returns {string}
 */
export function cleanAssistantText(raw, agent) {
  const rules = rulesFor(agent);
  let text = raw;
  if (rules.noise.includes("system-reminder")) text = stripTag(text, "system-reminder");
  return stripAnsi(text);
}
