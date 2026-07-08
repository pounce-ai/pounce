/**
 * Split assistant markdown into renderable segments, lifting shell code blocks
 * out so the UI can give them a "Run" affordance. Everything else — prose and
 * non-shell code blocks — stays as markdown and renders through the normal
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

/** A run of prose/markdown, or a single runnable shell command. */
export type Segment =
  | { type: "md"; text: string }
  | { type: "run"; command: string };

// Fenced block: ```lang\n …body… ``` (lang optional). Non-greedy body.
const FENCE_RE = /```([\w-]*)[ \t]*\r?\n([\s\S]*?)```/g;

/** Drop a leading shell prompt (`$ `, `% `, `# `) from each line so a copied
 *  `$ npm install` becomes a runnable `npm install`. */
function stripPrompts(body: string): string {
  return body
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/^\s*[$%#]\s+/, ""))
    .join("\n")
    .trim();
}

/**
 * Break `text` into segments. Shell-tagged fenced blocks become `run` segments;
 * everything else stays in `md` segments. If there are no shell blocks, returns
 * a single `md` segment (the whole text) so rendering is unchanged.
 */
export function splitShellBlocks(text: string): Segment[] {
  const segments: Segment[] = [];
  let lastIndex = 0;
  let hasRun = false;

  const pushMd = (chunk: string) => {
    const trimmed = chunk.trim();
    if (trimmed) segments.push({ type: "md", text: trimmed });
  };

  FENCE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FENCE_RE.exec(text)) !== null) {
    const lang = m[1].toLowerCase();
    if (!SHELL_LANGS.has(lang)) continue; // leave non-shell blocks inside md
    const command = stripPrompts(m[2]);
    if (!command) continue;
    pushMd(text.slice(lastIndex, m.index));
    segments.push({ type: "run", command });
    lastIndex = m.index + m[0].length;
    hasRun = true;
  }

  if (!hasRun) return [{ type: "md", text }];
  pushMd(text.slice(lastIndex));
  return segments;
}
