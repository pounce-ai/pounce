/**
 * Split assistant markdown into renderable segments, lifting *all* fenced code
 * blocks out so the UI can syntax-highlight them (and give shell blocks a "Run"
 * affordance). Prose between fences stays markdown and renders through the
 * native markdown view.
 */

/** Fenced-block languages we treat as runnable shell commands. */
const SHELL_LANGS = new Set([
  "bash",
  "sh",
  "shell",
  "zsh",
  "console",
  "shell-session",
  "sh-session",
]);

/** A run of prose/markdown, or a fenced code block (runnable if it's a shell). */
export type Segment =
  | { type: "md"; text: string }
  | { type: "code"; lang: string; code: string; runnable: boolean };

// Fenced block: ```lang\n …body… ``` (lang optional). Non-greedy body.
const FENCE_RE = /```([\w-]*)[ \t]*\r?\n([\s\S]*?)```/g;

/** Drop a leading shell prompt (`$ `, `% `, `# `) or Claude Code's bang prefix
 *  (`!cmd`) from each line so a copied `$ npm install` / `!git status` becomes
 *  a runnable `npm install` / `git status`. */
function stripPrompts(body: string): string {
  return body
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[$%#]\s+|!(?=\S))/, ""))
    .join("\n")
    .trim();
}

/** Whether an untagged fenced block reads as a one-liner shell command (agents
 *  often omit the ```bash tag on commands). One non-empty line starting with a
 *  plausible command token — generous on purpose: "Run" only inserts the
 *  command into the composer for the user to review and send, never executes. */
function looksLikeCommand(body: string): boolean {
  const lines = stripPrompts(body)
    .split("\n")
    .filter((l) => l.trim());
  if (lines.length !== 1) return false;
  const line = lines[0].trim();
  return line.length < 300 && /^[A-Za-z_.~/][\w.~/+-]*(\s|$)/.test(line);
}

/**
 * Break `text` into segments. Every fenced block becomes a `code` segment
 * (shell-tagged ones marked `runnable`); prose stays in `md` segments. With no
 * fenced blocks, returns a single `md` segment so rendering is unchanged.
 */
export function splitCodeBlocks(text: string): Segment[] {
  const segments: Segment[] = [];
  let lastIndex = 0;
  let hasCode = false;

  const pushMd = (chunk: string) => {
    const trimmed = chunk.trim();
    if (trimmed) segments.push({ type: "md", text: trimmed });
  };

  FENCE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FENCE_RE.exec(text)) !== null) {
    const lang = m[1].toLowerCase();
    // Shell-tagged blocks are runnable; so are untagged one-liners that read as
    // a command (agents routinely fence commands with a bare ```).
    const runnable = SHELL_LANGS.has(lang) || (lang === "" && looksLikeCommand(m[2]));
    const code = runnable ? stripPrompts(m[2]) : m[2].replace(/\r\n/g, "\n").replace(/\n$/, "");
    if (!code.trim()) continue;
    pushMd(text.slice(lastIndex, m.index));
    segments.push({ type: "code", lang, code, runnable });
    lastIndex = m.index + m[0].length;
    hasCode = true;
  }

  if (!hasCode) return [{ type: "md", text }];
  pushMd(text.slice(lastIndex));
  return segments;
}
