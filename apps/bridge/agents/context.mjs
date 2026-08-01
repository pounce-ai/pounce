/**
 * A project's agent-context files — CLAUDE.md, AGENTS.md and friends — read and
 * written for the app.
 *
 * Deliberately a FIXED WHITELIST, in both directions. This serves and accepts
 * file CONTENT over the network, so it is scoped the same way /v1/file is
 * scoped to images: a closed list of names, resolved under one directory, with
 * symlinks that point outside rejected. A `?path=` parameter here would be a
 * repo-wide read/write primitive.
 *
 * On writing: these files were read-only at first, on the reasoning that a
 * repo change should land through an agent turn where git shows a diff. That
 * still holds for the phone, and the "leave notes → hand them to an agent"
 * flow it exists for is unchanged. But a context file is prose the user WRITES
 * — the desktop app is a local editor sitting on the same machine as the repo,
 * and making someone dictate a typo fix to an agent is ceremony, not safety.
 * So `writeContextFile` exists, with the guards that make an unattended edit
 * survivable:
 *
 *   • the same whitelist + containment checks as the read path;
 *   • an mtime precondition, so a user's save can't silently clobber an edit
 *     an agent made while the editor was open (and vice versa);
 *   • an atomic tmp+rename, so an agent reading the file mid-save never sees
 *     a half-written one.
 *
 * These files are tracked by git like any other, so an unwanted edit is still
 * one `git checkout` away — the diff review just happens after the fact.
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

/**
 * Resolve a client-supplied file name against the whitelist.
 *
 * Returns the canonical relative path (in the host's separator) or null. The
 * comparison is against the whitelist ENTRIES, not against the string shape, so
 * `../../.ssh/config`, `CLAUDE.md/../../x` and an absolute path all simply fail
 * to match rather than needing to be detected.
 */
function whitelisted(rel) {
  if (typeof rel !== "string" || !rel) return null;
  const want = rel.split(/[\\/]/).join(path.sep);
  return CONTEXT_FILES.find((c) => c === want) ?? null;
}

/**
 * Write one context file under `cwd`, creating it if it doesn't exist.
 *
 * `expectedMtime` is an optimistic-concurrency precondition: the ISO mtime the
 * caller last read. Pass it and the write is rejected (`conflict`) when the
 * file has changed underneath — the case that matters is an agent turn editing
 * CLAUDE.md while someone has the editor open on it. Pass `null` to mean "I
 * expect this file not to exist yet"; omit it (undefined) to force the write.
 *
 * The stamp is millisecond-resolution, so two writes inside the same
 * millisecond are indistinguishable to it. That's fine for what this guards:
 * the competing writer is an agent turn, which takes seconds of wall clock
 * between reading a file and rewriting it, not microseconds. It is NOT a lock,
 * and isn't trying to be one.
 *
 * Returns `{ ok: true, file }` with the same per-file shape `readContextFiles`
 * emits, or `{ ok: false, error }` — the caller maps `error` onto a status.
 */
export async function writeContextFile(cwd, rel, content, expectedMtime) {
  const name = whitelisted(rel);
  if (!name) return { ok: false, error: "not a context file" };
  if (typeof content !== "string") return { ok: false, error: "content required" };
  if (Buffer.byteLength(content, "utf8") > MAX_FILE) return { ok: false, error: "too large" };

  let root;
  try {
    root = await fsp.realpath(cwd);
    if (!(await fsp.stat(root)).isDirectory()) return { ok: false, error: "not found" };
  } catch {
    return { ok: false, error: "not found" };
  }

  const target = path.join(root, name);
  // Resolve the EXISTING file through symlinks, exactly as the read path does:
  // a CLAUDE.md symlinked out of the project must not become a write primitive
  // pointing at ~/.ssh/config. A file that doesn't exist yet resolves to the
  // literal path under root, which containment then confirms.
  let real;
  let current = null;
  try {
    real = await fsp.realpath(target);
    const st = await fsp.stat(real);
    if (!st.isFile()) return { ok: false, error: "not a file" };
    current = st;
  } catch {
    real = target;
  }
  if (!isInside(real, root)) return { ok: false, error: "outside project" };

  // Optimistic concurrency. `undefined` opts out; `null` asserts "new file".
  if (expectedMtime !== undefined) {
    const seen = current ? new Date(current.mtimeMs).toISOString() : null;
    if (seen !== expectedMtime) return { ok: false, error: "conflict", file: seen };
  }

  // `.claude/` may not exist yet when someone drafts the nested form.
  try {
    await fsp.mkdir(path.dirname(real), { recursive: true });
  } catch {
    return { ok: false, error: "write failed" };
  }

  // tmp + rename: an agent reading this file while it's being saved gets the
  // old bytes or the new ones, never a truncated middle. Same directory, so
  // the rename stays on one filesystem and is therefore atomic.
  const tmp = `${real}.pounce-${process.pid}.tmp`;
  try {
    await fsp.writeFile(tmp, content, "utf8");
    await fsp.rename(tmp, real);
  } catch {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    return { ok: false, error: "write failed" };
  }

  let st;
  try {
    st = await fsp.stat(real);
  } catch {
    return { ok: false, error: "write failed" };
  }
  return {
    ok: true,
    file: {
      path: name.split(path.sep).join("/"),
      name: path.basename(name),
      size: st.size,
      mtime: new Date(st.mtimeMs).toISOString(),
      content,
      truncated: false,
    },
  };
}

export { CONTEXT_FILES };
