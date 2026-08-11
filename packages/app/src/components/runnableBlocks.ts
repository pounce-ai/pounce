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

/**
 * Programs an untagged one-liner has to START with before we'll offer to run it.
 *
 * The old test was "one line, starts with a word character", which is most
 * source code ever written: `sending || activity === "running"` passed it and
 * grew a Run button. A recognised program name is the only cheap test that
 * actually distinguishes a COMMAND from a line of code — a guess dressed as an
 * affordance is worse than no affordance, because the user finds out by tapping.
 *
 * Explicitly-tagged shell blocks (```bash) skip this entirely; this list is only
 * for the untagged case, which agents do produce for commands.
 */
const COMMANDS = new Set([
  // package managers + runtimes
  "npm",
  "npx",
  "pnpm",
  "pnpx",
  "yarn",
  "bun",
  "bunx",
  "deno",
  "node",
  "python",
  "python3",
  "pip",
  "pip3",
  "ruby",
  "gem",
  "cargo",
  "go",
  "rustup",
  "brew",
  "apt",
  "apt-get",
  "dnf",
  "pacman",
  "uv",
  "poetry",
  "rye",
  "pipx",
  // vcs + platform tools
  "git",
  "gh",
  "docker",
  "kubectl",
  "terraform",
  "aws",
  "gcloud",
  "az",
  "flyctl",
  "vercel",
  "netlify",
  "wrangler",
  "supabase",
  "heroku",
  "eas",
  "expo",
  "pod",
  "xcrun",
  "xcodebuild",
  "adb",
  "gradle",
  "fastlane",
  "swift",
  "make",
  "cmake",
  // shell builtins + coreutils people actually paste
  "cd",
  "ls",
  "cat",
  "echo",
  "mkdir",
  "rm",
  "cp",
  "mv",
  "touch",
  "chmod",
  "chown",
  "ln",
  "pwd",
  "which",
  "whoami",
  "export",
  "source",
  "sudo",
  "kill",
  "pkill",
  "ps",
  "top",
  "df",
  "du",
  "tar",
  "zip",
  "unzip",
  "curl",
  "wget",
  "ssh",
  "scp",
  "rsync",
  "grep",
  "rg",
  "find",
  "fd",
  "sed",
  "awk",
  "sort",
  "uniq",
  "head",
  "tail",
  "wc",
  "diff",
  "open",
  "code",
  "vim",
  "nano",
  "less",
  "tree",
  "jq",
]);

/**
 * Does an untagged fenced block read as a shell command?
 *
 * One non-empty line, starting with a program we recognise. Deliberately a
 * whitelist: see COMMANDS. Running is still never automatic — "Run" only puts
 * the command in the composer for the user to send.
 */
function looksLikeCommand(body: string): boolean {
  const lines = stripPrompts(body)
    .split("\n")
    .filter((l) => l.trim());
  if (lines.length !== 1) return false;
  const line = lines[0].trim();
  if (line.length >= 300) return false;
  // Code punctuation a shell command wouldn't open with — cheap reject before
  // the lookup, and it catches `foo({...})`-shaped calls whose first token
  // could otherwise collide with a program name.
  if (/[{}();]|=>|===|!==|\|\||&&\s*\w+\s*\(/.test(line)) return false;
  const program = line.split(/\s/)[0].replace(/^.*\//, "");
  return COMMANDS.has(program);
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

/**
 * Would running this be hard to take back?
 *
 * Not a security boundary — anything reachable from `/bin/sh` can do damage,
 * and a list of patterns will never catch it all. It decides one thing: whether
 * the card asks for a deliberate gesture (press and hold) instead of a tap.
 * Command DETECTION is a heuristic and the arguments are whatever an agent
 * wrote, so `rm -rf build` reads exactly like `ls` to that check — this is the
 * guard against a fat-finger, held to the same standard as any other
 * irreversible control.
 *
 * Wrong in the safe direction on purpose: a false positive costs a long press.
 */
const DESTRUCTIVE = [
  /(^|\s|\|)sudo\s/, // anything as root
  /(^|\s|\|)rm\s/, // rm, with or without flags
  /(^|\s|\|)(rmdir|shred|srm)\s/,
  /(^|\s|\|)(kill|pkill|killall)\s/,
  /(^|\s|\|)(mv|cp)\s+[^|]*\s+\/(?!\/)/, // moving/copying onto an absolute path
  />\s*\/\S/, // redirecting into an absolute path
  /(^|\s)git\s+(reset\s+--hard|clean\s+-[a-z]*f|push\s+[^|]*--force|branch\s+-D)/,
  /(^|\s)(dd|mkfs|fdisk|diskutil)\s/,
  /(^|\s)(drop|truncate)\s+(table|database)/i,
  /(^|\s)(npm|pnpm|yarn|bun)\s+(unpublish|deprecate)/,
  /(^|\s)docker\s+(system\s+prune|rmi|rm)\s/,
  /(^|\s)(shutdown|reboot|halt)\b/,
  /:\(\)\s*\{.*\|.*&.*\}/, // fork bomb
];

/** True when the command should need a press-and-hold rather than a tap. */
export function isDestructive(command: string): boolean {
  const line = command.trim();
  return DESTRUCTIVE.some((re) => re.test(line));
}
