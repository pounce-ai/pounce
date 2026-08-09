/**
 * Tool name → glyph. What a call DID, at a glance.
 *
 * Every non-shell tool used to render the same `⚙`, so a run of calls was a
 * wall of identical rows and you had to read each name to find the edit among
 * the reads.
 *
 * Matching is on substrings of a normalised name because the four agents spell
 * the same operation differently — Claude's `Edit`, codex's `apply_patch`,
 * opencode's `write`, cursor's `edit_file` — and MCP tools arrive wrapped as
 * `mcp__<server>__<tool>`, which the prefix strip unwraps so
 * `mcp__claude-in-chrome__navigate` still reads as a browser call.
 *
 * Lives apart from Timeline.tsx so it can be tested without mounting the list.
 */
import type { IoniconName } from "../ui/native/icon-map";

/**
 * Shell-ish names across the four agents — claude/opencode say `shell`, codex
 * `exec_command`, cursor `run_terminal_cmd`. Matched on underscore-delimited
 * words so `todowrite` and `cache_clear` can't sneak in.
 */
export const SHELL_RE = /(^|_)(shell|bash|zsh|sh|exec|terminal|cmd)(_|$)/;

/**
 * First hit wins, so narrow patterns precede broad ones — `todowrite` is a task
 * list, not a write. Anything unrecognised falls through to a wrench rather
 * than guessing: an honest "some tool" beats a confidently wrong icon.
 */
const TOOL_ICONS: [RegExp, IoniconName][] = [
  // `todowrite` has no separator to anchor on, so todo/task match as prefixes;
  // `plan` matches as a whole word so it catches update_plan and *_plan_mode.
  [/^(todo|task)|(^|_)plan(_|$)/, "list-outline"],
  [
    /(websearch|web_search|webfetch|web_fetch|fetch|browse|navigate|tabs|http|url)/,
    "globe-outline",
  ],
  [/(askuserquestion|question|ask)/, "help-circle-outline"],
  [/(grep|search|ripgrep|codebase)/, "search"],
  [/(glob|^ls$|list_dir|listdir|find|dir)/, "folder-outline"],
  [/(apply_patch|patch|edit|replace)/, "pencil-outline"],
  [/(write|create|touch)/, "create-outline"],
  [/(read|cat|view|open|file)/, "document-text-outline"],
  [/(git|commit|branch|diff)/, "git-branch-outline"],
  [/(computer|screenshot|click|browser|chrome)/, "desktop-outline"],
];

/**
 * Lowercase, unwrap an MCP prefix, split camelCase, and reduce punctuation runs
 * to single underscores — so `read_file`, `readFile` and `Cachebro_read_file`
 * all normalise to the same shape.
 */
export function normalizeToolName(name: string): string {
  return name
    .replace(/^mcp__[^_]*(?:__)?/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_");
}

/** True when this tool is a shell command (rendered as `$ cmd`, not an icon). */
export function isShellTool(name: string): boolean {
  return SHELL_RE.test(normalizeToolName(name));
}

export function toolIcon(name: string): IoniconName {
  const norm = normalizeToolName(name);
  for (const [re, icon] of TOOL_ICONS) if (re.test(norm)) return icon;
  return "construct-outline";
}
