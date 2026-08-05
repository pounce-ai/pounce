/**
 * Which project does a working directory belong to?
 *
 * Sessions run in worktrees as often as in checkouts, and a worktree has to
 * group under the project it was cut from — a Space is a project, not a
 * directory. The hard case is that worktrees are routinely deleted once merged,
 * long before anyone asks the question.
 *
 * This asks the REPOS, not the worktrees. Every live cwd names its repo root,
 * and a repo root enumerates all of its worktrees — including ones whose
 * directory is already gone, because git keeps that admin entry in
 * `<repo>/.git/worktrees/<name>/` until something prunes it. Asking in the other
 * direction ("worktree, who is your origin?") can only ever work while the
 * directory is still there, which loses every archived worktree permanently.
 *
 * It is also tool-agnostic. Worktree layouts are per-tool conventions —
 * superset writes `~/.superset/worktrees/<workspace>/<name>`, Claude Code writes
 * `<repo>/.claude/worktrees/<name>`, a hand-run `git worktree add` writes
 * wherever it was pointed — so parsing paths mislabels whichever tool you
 * haven't seen yet. Git records the link regardless of who created the worktree,
 * so one code path covers all of them and the next tool needs no changes.
 */
import { existsSync } from "node:fs";
import { Store } from "./store.mjs";

/** Forward slashes only (so Windows paths compare) and no trailing slash, so a
 *  path is usable as its own prefix key. */
export const normPath = (p) => (p || "").replace(/\\/g, "/").replace(/\/+$/, "");

export const baseName = (p) => normPath(p).split("/").pop() || normPath(p);

/**
 * @param {object} deps
 * @param {(cwd: string, args: string[]) => Promise<{code: number, out: string}>} deps.git
 * @param {(p: string) => boolean} [deps.exists]
 * @param {Store} [deps.store]  absolute worktree path → owning repo name.
 *   Persisted: a path's owner is a durable fact, and rederiving it costs a git
 *   call per repo on every boot. The mapping outliving the directory is the
 *   whole point — an archived worktree has nothing left on disk to ask.
 */
export function createWorktreeIndex({ git, exists = existsSync, store } = {}) {
  // New namespace on purpose: the previous `worktree-repos` store was keyed by a
  // parsed workspace id, a notion this no longer has. Stale rows are never read.
  const owners = store ?? new Store("worktree-owners");

  /** Longest first, so a cwd inside a worktree that itself sits inside another
   *  repo's tree matches the deepest worktree containing it. */
  const keys = () => Object.keys(owners.all()).sort((a, b) => b.length - a.length);
  let known = keys();

  /** Registered worktree path containing `cwd`, or undefined. */
  const ownerPathFor = (cwd) => known.find((p) => cwd === p || cwd.startsWith(`${p}/`));

  /**
   * Every worktree registered with the repo at `root`, as [absolute path, repo
   * name]. Includes worktrees whose directory is gone.
   */
  async function worktreesOf(root) {
    const { code, out } = await git(root, ["worktree", "list", "--porcelain"]);
    if (code !== 0) return [];
    const paths = out
      .split(/\r?\n/)
      .filter((l) => l.startsWith("worktree "))
      .map((l) => normPath(l.slice("worktree ".length)));
    // git lists the main checkout first: that one IS the repo, not a worktree of it.
    const [main, ...rest] = paths;
    if (!main) return [];
    const name = baseName(main);
    return rest.map((p) => [p, name]);
  }

  /** Main checkout path for a live directory, from anywhere inside it (worktree
   *  or subdirectory). Null when `cwd` isn't in a git repo at all. */
  async function repoRootOf(cwd) {
    const { code, out } = await git(cwd, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    if (code !== 0) return null;
    const commonDir = normPath(out.trim().split(/\r?\n/)[0]);
    const root = commonDir.replace(/\/\.git$/, "");
    // A path that didn't end in /.git is a bare repo (or something odd) — it
    // owns no worktrees worth attributing, so don't invent a name from it.
    return root && root !== commonDir ? root : null;
  }

  /**
   * Rewrite worktree threads' `repo` to the project they were cut from, in
   * place. Best-effort: a directory git can't account for keeps the repo name it
   * arrived with, so it still reads as its own folder rather than joining an
   * anonymous shared bucket.
   */
  async function resolve(threads) {
    // Only directories we can't already place are worth a git call. Plain repo
    // checkouts never match an owner, so they're swept every pass — which is
    // exactly how a newly created worktree gets picked up.
    const unplaced = [...new Set(threads.map((t) => normPath(t.cwd)).filter(Boolean))].filter(
      (cwd) => !ownerPathFor(cwd) && exists(cwd),
    );
    const roots = new Set(
      (await Promise.all(unplaced.map((cwd) => repoRootOf(cwd).catch(() => null)))).filter(Boolean),
    );
    const swept = await Promise.all([...roots].map((r) => worktreesOf(r).catch(() => [])));

    let learned = false;
    for (const [p, name] of swept.flat()) {
      if (owners.get(p) === name) continue;
      owners.set(p, name);
      learned = true;
    }
    if (learned) known = keys();

    for (const t of threads) {
      const cwd = normPath(t.cwd);
      if (!cwd) continue;
      const hit = ownerPathFor(cwd);
      if (!hit) continue;
      t.repo = owners.get(hit);
      t.isWorktree = true;
      t.worktree = baseName(hit);
    }
    return threads;
  }

  return { resolve, ownerPathFor, worktreesOf, repoRootOf };
}
