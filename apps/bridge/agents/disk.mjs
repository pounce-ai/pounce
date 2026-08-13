/**
 * What the agents have left on the disk, and what is safe to take back.
 *
 * Every agent that works in parallel does it by cutting worktrees, and nothing
 * cuts them back. A month of that is tens of gigabytes of `node_modules` under
 * directories whose branches merged weeks ago — and the cost is invisible,
 * because it isn't in one place and no tool owns it. `du -sh ~` tells you the
 * total; it can't tell you which of those directories anybody still needs.
 *
 * So this measures worktrees ONLY. Not the checkouts they were cut from (a
 * checkout is yours, not the agent's, and must never be offered for deletion),
 * and not the agents' own data directories (~/.claude, ~/.codex — real disk, but
 * nothing on this screen could act on them, and a graph that counts bytes you
 * can't reclaim is a graph that lies about what deleting would achieve).
 *
 * Attribution is by WORK, not by path: a worktree belongs to the agent whose
 * threads actually ran in it, because worktree layouts are per-tool conventions
 * (see ./worktrees.mjs) and reading the agent out of a path mislabels whichever
 * tool you haven't seen yet.
 *
 * Nothing here deletes on its own. `removeWorktree` refuses any path the index
 * doesn't already know as a worktree, and refuses a dirty one unless the caller
 * says so explicitly — the app turns that refusal into a choice rather than a
 * failure.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { baseName, normPath } from "./worktrees.mjs";

/** A tree's measured size is stable for far longer than a dashboard is open —
 *  it only moves when something builds — and `du` over a deep tree is the
 *  expensive part of this whole report. */
const SIZE_TTL_MS = 15 * 60_000;
/** A tree that takes longer than this to measure gets reported without a size
 *  rather than holding up every other row. */
const DU_TIMEOUT_MS = 20_000;
/** Enough parallelism to keep the disk busy, not enough to thrash it. */
const DU_CONCURRENCY = 4;

const sizes = new Map(); // path → { at, bytes }

/** Run `fn` over `items` with at most `limit` in flight. */
async function mapLimit(items, limit, fn) {
  const q = items.slice();
  await Promise.all(
    Array.from({ length: Math.min(limit, q.length) }, async () => {
      while (q.length) await fn(q.shift());
    }),
  );
}

/**
 * Bytes under a directory.
 *
 * `du` is the fast path and the accurate one — it counts allocated blocks and
 * it counts hard links once, which matters because package managers link into
 * a shared store rather than copying. The JS walk is the Windows fallback: it
 * reports apparent size, which reads a little high, but a rough figure beats
 * the blank the platform would otherwise get.
 */
async function duBytes(dir, exec) {
  if (process.platform !== "win32") {
    const { code, out } = await exec("du", ["-sk", dir], DU_TIMEOUT_MS);
    // `du` exits non-zero for an unreadable subdirectory while still totalling
    // everything it COULD read, so a partial answer is used when there is one.
    const kb = Number.parseInt(out.trim().split(/\s+/)[0], 10);
    if (Number.isFinite(kb)) return kb * 1024;
    if (code !== 0) return null;
  }
  return walkBytes(dir);
}

/** Apparent size of a tree, without shelling out. Symlinks are counted as the
 *  link, never followed — a followed symlink can leave the tree entirely and,
 *  pointing at an ancestor, never terminate. */
function walkBytes(dir, depth = 0) {
  if (depth > 40) return 0;
  let total = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      total += walkBytes(full, depth + 1);
      continue;
    }
    try {
      total += statSync(full).size;
    } catch {}
  }
  return total;
}

/** Measured size, memoized — see SIZE_TTL_MS. */
async function sizeOf(dir, exec, now) {
  const hit = sizes.get(dir);
  if (hit && now - hit.at < SIZE_TTL_MS) return hit.bytes;
  const bytes = await duBytes(dir, exec).catch(() => null);
  sizes.set(dir, { at: now, bytes });
  return bytes;
}

/** Forget a tree's measurement — after removing it, or on an explicit refresh. */
export function forgetSize(dir) {
  if (dir) sizes.delete(normPath(dir));
  else sizes.clear();
}

/** Threads that ran inside `dir`, newest first. A thread's cwd is often a
 *  subdirectory of the worktree, so this is a prefix match, not equality. */
function threadsIn(dir, threads) {
  const inside = threads.filter((t) => {
    const cwd = normPath(t.cwd || "");
    return cwd === dir || cwd.startsWith(`${dir}/`);
  });
  return inside.sort((a, b) => when(b).localeCompare(when(a)));
}

/** When a thread was last touched. `lastActivityAt` is only enriched for live
 *  threads, so `createdAt` is what an old thread has — and for "has anything
 *  happened here lately", a creation date is a true answer. */
const when = (t) => t.lastActivityAt || t.createdAt || "";

/**
 * Git facts about one worktree, each one degrading to null rather than failing
 * the row: a worktree whose repo is unreadable still has a size worth showing.
 */
async function gitFacts(dir, git) {
  const [branch, status, unpushed] = await Promise.all([
    git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]),
    git(dir, ["status", "--porcelain=v1", "--untracked-files=all"]),
    // Commits on this worktree that exist on no remote. `@{upstream}` is the
    // wrong question — a branch that was never pushed HAS no upstream, and the
    // whole point is to notice exactly that branch.
    git(dir, ["rev-list", "--count", "HEAD", "--not", "--remotes"]),
  ]);
  // `null`, never 0, when git couldn't answer. A worktree whose admin entry has
  // been pruned — which is exactly the kind that accumulates — fails every git
  // command in here, and reading that failure as "clean" would let the one
  // check standing between a tap and someone's uncommitted work pass silently.
  const dirtyFiles = status.code === 0 ? status.out.split("\n").filter(Boolean).length : null;
  const n = Number.parseInt(unpushed.out.trim(), 10);
  return {
    branch: branch.code === 0 ? branch.out.trim() || null : null,
    dirtyFiles,
    unpushed: Number.isFinite(n) ? n : null,
  };
}

/** Whole days since `iso`, or null when there's nothing to date it by. */
function daysSince(iso, now) {
  const t = Date.parse(iso || "");
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((now - t) / 86_400_000));
}

/**
 * Every known worktree, sized and dated.
 *
 * @param {object} deps
 * @param {Record<string,string>} deps.owners  worktree path → owning repo name,
 *   from the worktree index. Its keys are the ONLY paths this file will ever
 *   measure or remove.
 * @param {Array} deps.threads  the bridge's thread list (cwd, agent, dates).
 */
export async function readDisk({
  owners,
  threads = [],
  git,
  exec,
  exists = existsSync,
  now = Date.now(),
} = {}) {
  // A worktree whose directory is gone still has an index entry (that is how a
  // merged thread keeps its project — see worktrees.mjs). It occupies no disk,
  // so it is not a row here.
  const dirs = Object.keys(owners ?? {})
    .map(normPath)
    .filter((p) => p && exists(p));

  const rows = [];
  await mapLimit(dirs, DU_CONCURRENCY, async (dir) => {
    const mine = threadsIn(dir, threads);
    const [bytes, facts] = await Promise.all([
      sizeOf(dir, exec, now),
      gitFacts(dir, git).catch(() => ({ branch: null, dirtyFiles: null, unpushed: null })),
    ]);
    // Newest thread first, so the agent credited is the one that worked here
    // last — a worktree handed from one agent to another belongs to whoever
    // has it now, which is also whose thread the "open it instead" choice opens.
    const last = mine[0] ?? null;
    // No thread ever ran here (a hand-made `git worktree add`, or history that
    // has since been pruned): the directory's own mtime is then the only date
    // there is. Kept distinct so the app can say which question it answered.
    const lastActivityAt = last ? when(last) || null : mtimeIso(dir);
    rows.push({
      path: dir,
      name: baseName(dir),
      repo: owners[dir] ?? null,
      branch: facts.branch,
      agent: last?.agent ?? null,
      bytes,
      threads: mine.length,
      lastActivityAt,
      idleDays: daysSince(lastActivityAt, now),
      dirtyFiles: facts.dirtyFiles,
      unpushed: facts.unpushed,
      lastThreadId: last?.id ?? null,
    });
  });

  // Biggest first: this screen exists to answer "what is eating the disk".
  rows.sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0));

  const byAgent = new Map();
  for (const r of rows) {
    // `null` is a real bucket, not a missing one — worktrees no agent claims
    // are often the oldest and biggest, and folding them into another agent's
    // bar would blame it for disk it never used.
    const key = r.agent ?? "";
    const row = byAgent.get(key) ?? { agent: r.agent, bytes: 0, worktrees: 0 };
    row.bytes += r.bytes ?? 0;
    row.worktrees++;
    byAgent.set(key, row);
  }

  return {
    scannedAt: new Date(now).toISOString(),
    // Rows whose size couldn't be measured contribute nothing rather than a
    // guess, so this total is a floor — the app says as much when any row is
    // unmeasured.
    totalBytes: rows.reduce((n, r) => n + (r.bytes ?? 0), 0),
    unmeasured: rows.filter((r) => r.bytes == null).length,
    agents: [...byAgent.values()].sort((a, b) => b.bytes - a.bytes),
    worktrees: rows,
  };
}

function mtimeIso(dir) {
  try {
    return new Date(statSync(dir).mtimeMs).toISOString();
  } catch {
    return null;
  }
}

/**
 * Delete one worktree.
 *
 * Refusals are the interesting part, and both are returned as outcomes rather
 * than thrown, so the app can offer the user the next move:
 *
 *   `unknown`  the path isn't a worktree this bridge indexed. This is what
 *              stops the endpoint being a remote `rm -rf` with a path
 *              parameter — a repo checkout, a home directory or anything else
 *              typed in cannot match, because only worktree paths are indexed.
 *   `dirty`    there are uncommitted changes, and `force` wasn't given. The
 *              caller gets the file count and the last thread that ran here so
 *              it can offer to open that thread instead of destroying it.
 *
 * `git worktree remove` is run from the REPO, never from inside the directory
 * being removed, and prunes the admin entry after. When git can't do it (the
 * repo is gone, the entry was already pruned), the directory is removed
 * directly — otherwise a pruned worktree would be undeletable from here
 * forever, which is exactly the state that accumulates.
 */
export async function removeWorktree({
  path: target,
  force = false,
  deleteBranch = false,
  owners,
  threads = [],
  git,
  rm,
  repoRootOf,
  exists = existsSync,
} = {}) {
  const dir = normPath(target || "");
  if (!dir || !Object.hasOwn(owners ?? {}, dir)) return { ok: false, reason: "unknown" };
  if (!exists(dir)) return { ok: false, reason: "gone" };

  const facts = await gitFacts(dir, git).catch(() => ({
    branch: null,
    dirtyFiles: null,
    unpushed: null,
  }));
  // `!== 0` rather than `> 0`: null means git couldn't say, and "couldn't say"
  // must ask, not assume. Only a clean tree git actually vouched for skips this.
  if (facts.dirtyFiles !== 0 && !force) {
    const last = threadsIn(dir, threads)[0] ?? null;
    return {
      ok: false,
      reason: "dirty",
      dirtyFiles: facts.dirtyFiles,
      unpushed: facts.unpushed,
      branch: facts.branch,
      lastThreadId: last?.id ?? null,
      lastThreadAgent: last?.agent ?? null,
    };
  }

  const root = await repoRootOf(dir).catch(() => null);
  let removed = false;
  if (root) {
    const r = await git(root, ["worktree", "remove", "--force", dir]);
    removed = r.code === 0;
    if (removed) await git(root, ["worktree", "prune"]);
  }
  if (!removed && exists(dir)) {
    // git wouldn't or couldn't; the bytes are the point, so take the directory.
    try {
      await rm(dir);
      removed = !exists(dir);
    } catch {
      removed = false;
    }
    if (removed && root) await git(root, ["worktree", "prune"]);
  }
  if (!removed) return { ok: false, reason: "failed", branch: facts.branch };
  forgetSize(dir);

  // The branch is a separate act with separate consequences, so it is only ever
  // done when explicitly asked. `-D` because a branch whose worktree just went
  // is by definition not merged into the branch we're standing on.
  let branchDeleted = false;
  if (deleteBranch && root && facts.branch && facts.branch !== "HEAD") {
    branchDeleted = (await git(root, ["branch", "-D", facts.branch])).code === 0;
  }
  return {
    ok: true,
    path: dir,
    branch: facts.branch,
    branchDeleted,
    unpushed: facts.unpushed,
  };
}
