/**
 * A project's agent-context files — CLAUDE.md, AGENTS.md and friends — read for
 * display in the app.
 *
 * Deliberately READ-ONLY, and deliberately a fixed whitelist. Two reasons:
 *
 *   • No write endpoint. Editing a project's instructions is a change to the
 *     repo, and changes to the repo go through an agent turn where they land in
 *     git with a diff the user can review — not through a phone PUT that
 *     silently rewrites a file. The app collects comments and hands them to a
 *     new thread; the agent makes the edit.
 *
 *   • No arbitrary paths. This serves file CONTENT over the network, so it is
 *     scoped the same way /v1/file is scoped to images: a closed list of names,
 *     resolved under one directory, with symlinks that point outside rejected.
 *     A `?path=` parameter here would be a repo-wide read primitive.
 */
import fsp from "node:fs/promises";
import path from "node:path";

/**
 * The files an agent actually reads as project instructions. `.claude/CLAUDE.md`
 * is the nested form Claude Code supports; the `.local` variants are the
 * gitignored personal overrides.
 */
const CONTEXT_FILES = [
  "CLAUDE.md",
  "AGENTS.md",
  "CLAUDE.local.md",
  path.join(".claude", "CLAUDE.md"),
];

/** Per-file cap. Beyond this the content is cut and flagged `truncated` — these
 *  are prose files; one this big is pathological, not something to stream. */
const MAX_FILE = 256 * 1024;
/** Cap across the whole response, so a repo full of large files can't be used
 *  to pull a megabyte-per-request over a metered tunnel. */
const MAX_TOTAL = 1024 * 1024;

const IS_WIN = process.platform === "win32";

/** Case-insensitive on Windows/macOS-style filesystems where it matters. */
function isInside(child, parent) {
  const a = IS_WIN ? child.toLowerCase() : child;
  const b = IS_WIN ? parent.toLowerCase() : parent;
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

/**
 * Read every context file present under `cwd`.
 *
 * Returns `null` when `cwd` isn't a directory we can resolve — the caller turns
 * that into a 404. An empty `files` array is a normal answer: plenty of projects
 * have no CLAUDE.md yet, and the app offers to create one from that state.
 */
export async function readContextFiles(cwd) {
  let root;
  try {
    // realpath first: the whole containment check below compares resolved
    // paths, so a symlinked worktree root must resolve to its real location or
    // every file inside it would look like an escape.
    root = await fsp.realpath(cwd);
    if (!(await fsp.stat(root)).isDirectory()) return null;
  } catch {
    return null;
  }

  // Read the candidates concurrently — they're independent, and doing this
  // synchronously stalled the bridge's single event loop for up to MAX_TOTAL
  // of file I/O, freezing every other paired device's stream mid-request.
  const found = await Promise.all(
    CONTEXT_FILES.map(async (rel) => {
      let real;
      let st;
      try {
        real = await fsp.realpath(path.join(root, rel));
        st = await fsp.stat(real);
      } catch {
        return null; // absent, or a broken symlink — same outcome either way
      }
      if (!st.isFile()) return null;
      // A symlink pointing out of the project (…/CLAUDE.md -> ~/.ssh/config) is
      // the one way a fixed whitelist could still read something it shouldn't.
      if (!isInside(real, root)) return null;
      try {
        return { rel, st, content: await fsp.readFile(real, "utf8") };
      } catch {
        return null;
      }
    }),
  );

  // Caps applied in whitelist order so the response is deterministic regardless
  // of which read finished first.
  const files = [];
  let total = 0;
  for (const hit of found) {
    if (!hit || total >= MAX_TOTAL) continue;
    const budget = Math.min(MAX_FILE, MAX_TOTAL - total);
    const truncated = hit.content.length > budget;
    const content = truncated ? hit.content.slice(0, budget) : hit.content;
    total += content.length;

    files.push({
      // Forward-slashed regardless of host — the app treats this as an id and
      // shows it verbatim, and `.claude\CLAUDE.md` would read as a typo.
      path: hit.rel.split(path.sep).join("/"),
      name: path.basename(hit.rel),
      size: hit.st.size,
      mtime: new Date(hit.st.mtimeMs).toISOString(),
      content,
      truncated,
    });
  }
  return { cwd: root, files };
}

export { CONTEXT_FILES };
