import { describe, expect, it } from "vitest";
import { baseName, createWorktreeIndex, normPath } from "./worktrees.mjs";

/** In-memory stand-in for Store — same Map-like surface resolve() uses. */
function fakeStore(seed = {}) {
  const rows = new Map(Object.entries(seed));
  return {
    rows,
    get: (k) => rows.get(k),
    has: (k) => rows.has(k),
    all: () => Object.fromEntries(rows),
    set: (k, v) => rows.set(k, v),
  };
}

/**
 * Fake git over a declared world: `worktrees` maps a repo root to the worktree
 * paths git has on record for it (deleted ones included, as real git does), and
 * `roots` maps any directory to the repo root it sits in.
 */
function fakeGit({ worktrees = {}, roots = {} } = {}) {
  const calls = [];
  const git = async (cwd, args) => {
    calls.push([cwd, args.join(" ")]);
    if (args[0] === "worktree") {
      const list = worktrees[cwd];
      if (!list) return { code: 128, out: "" };
      // Real `git worktree list` names the main checkout first.
      const lines = [cwd, ...list].map((p) => `worktree ${p}\n`).join("\n");
      return { code: 0, out: lines };
    }
    if (args[0] === "rev-parse") {
      const root = roots[cwd];
      if (!root) return { code: 128, out: "" };
      return { code: 0, out: `${root}/.git\n` };
    }
    return { code: 1, out: "" };
  };
  return { git, calls };
}

const REPO = "/Users/x/Projects/pounce-mono";
const SUPERSET = "/Users/x/.superset/worktrees/d0f7efc8-f57a/v2";
const CLAUDE_WT = "/Users/x/Projects/pounce-mono/.claude/worktrees/feat-x";

describe("normPath / baseName", () => {
  it("normalizes separators and trailing slashes so a path is its own prefix key", () => {
    expect(normPath("C:\\repos\\app\\")).toBe("C:/repos/app");
    expect(normPath("/a/b//")).toBe("/a/b");
    expect(normPath(null)).toBe("");
    expect(baseName("/a/b/c/")).toBe("c");
  });
});

describe("worktree owner resolution", () => {
  it("groups a worktree under the repo it was cut from", async () => {
    const { git } = fakeGit({
      worktrees: { [REPO]: [SUPERSET] },
      roots: { [REPO]: REPO, [SUPERSET]: REPO },
    });
    const idx = createWorktreeIndex({ git, exists: () => true, store: fakeStore() });

    const threads = [
      { cwd: REPO, repo: "pounce-mono", isWorktree: false, worktree: null },
      { cwd: SUPERSET, repo: "v2", isWorktree: false, worktree: null },
    ];
    await idx.resolve(threads);

    expect(threads[1].repo).toBe("pounce-mono");
    expect(threads[1].isWorktree).toBe(true);
    expect(threads[1].worktree).toBe("v2");
    // The main checkout is not a worktree of itself.
    expect(threads[0].isWorktree).toBe(false);
    expect(threads[0].repo).toBe("pounce-mono");
  });

  it("resolves a worktree whose directory has been deleted", async () => {
    // The regression that produced duplicate anonymous Spaces: git still has the
    // record on the repo side, but nothing can run git inside a directory that
    // no longer exists, so the old worktree-side lookup lost these forever.
    const { git } = fakeGit({
      worktrees: { [REPO]: [SUPERSET] },
      roots: { [REPO]: REPO },
    });
    const idx = createWorktreeIndex({
      git,
      exists: (p) => p === REPO, // the worktree is gone
      store: fakeStore(),
    });

    const threads = [
      { cwd: REPO, repo: "pounce-mono" },
      { cwd: SUPERSET, repo: "v2" },
    ];
    await idx.resolve(threads);

    expect(threads[1].repo).toBe("pounce-mono");
    expect(threads[1].isWorktree).toBe(true);
  });

  it("treats every tool's worktree layout the same way", async () => {
    // superset's `<workspace>/<name>` and Claude Code's `.claude/worktrees/<name>`
    // share no path shape; only git's records tie either one to the repo.
    const { git } = fakeGit({
      worktrees: { [REPO]: [SUPERSET, CLAUDE_WT] },
      roots: { [REPO]: REPO },
    });
    const idx = createWorktreeIndex({ git, exists: (p) => p === REPO, store: fakeStore() });

    const threads = [
      { cwd: REPO, repo: "pounce-mono" },
      { cwd: SUPERSET, repo: "v2" },
      { cwd: CLAUDE_WT, repo: "feat-x" },
    ];
    await idx.resolve(threads);

    expect(threads.map((t) => t.repo)).toEqual(["pounce-mono", "pounce-mono", "pounce-mono"]);
    expect(threads[2].worktree).toBe("feat-x");
  });

  it("places a session running in a subdirectory of a worktree", async () => {
    const deep = `${SUPERSET}/apps/bridge`;
    const { git } = fakeGit({
      worktrees: { [REPO]: [SUPERSET] },
      roots: { [REPO]: REPO, [deep]: REPO },
    });
    const idx = createWorktreeIndex({ git, exists: () => true, store: fakeStore() });

    const threads = [
      { cwd: REPO, repo: "pounce-mono" },
      { cwd: deep, repo: "bridge" },
    ];
    await idx.resolve(threads);

    expect(threads[1].repo).toBe("pounce-mono");
    expect(threads[1].worktree).toBe("v2");
  });

  it("matches the deepest worktree when one is nested inside another repo's tree", async () => {
    const outer = "/Users/x/Projects/outer";
    const inner = `${outer}/vendor/inner`;
    const wt = `${inner}/.claude/worktrees/w`;
    const { git } = fakeGit({
      worktrees: { [outer]: [`${outer}/.claude/worktrees/o`], [inner]: [wt] },
      roots: { [outer]: outer, [inner]: inner },
    });
    const idx = createWorktreeIndex({ git, exists: () => true, store: fakeStore() });

    const threads = [
      { cwd: outer, repo: "outer" },
      { cwd: inner, repo: "inner" },
      { cwd: wt, repo: "w" },
    ];
    await idx.resolve(threads);

    expect(threads[2].repo).toBe("inner");
  });

  it("leaves a directory git cannot account for named after itself", async () => {
    // A plain copy with no .git, registered with no repo: nothing generic can
    // identify it, so it stays its own folder rather than joining a shared
    // bucket that would look like a duplicate of every other orphan.
    const orphan = "/Users/x/.superset/worktrees/efb16a56/leeward-galliform";
    const { git } = fakeGit({ worktrees: { [REPO]: [] }, roots: { [REPO]: REPO } });
    const idx = createWorktreeIndex({ git, exists: () => true, store: fakeStore() });

    const threads = [
      { cwd: REPO, repo: "pounce-mono" },
      { cwd: orphan, repo: "leeward-galliform" },
    ];
    await idx.resolve(threads);

    expect(threads[1].repo).toBe("leeward-galliform");
    expect(threads[1].isWorktree).toBeUndefined();
  });

  it("places a pruned worktree from its surviving siblings", async () => {
    // Deleted AND pruned: git has forgotten it, so the repo-side sweep can't see
    // it either. Its neighbours under the same workspace directory still testify.
    const live = "/Users/x/.superset/worktrees/d0f7efc8/v2";
    const pruned = "/Users/x/.superset/worktrees/d0f7efc8/salty-hibiscus";
    const { git } = fakeGit({
      worktrees: { [REPO]: [live] },
      roots: { [REPO]: REPO },
    });
    const idx = createWorktreeIndex({ git, exists: (p) => p === REPO, store: fakeStore() });

    const threads = [
      { cwd: REPO, repo: "pounce-mono" },
      { cwd: live, repo: "v2" },
      { cwd: pruned, repo: "salty-hibiscus" },
    ];
    await idx.resolve(threads);

    expect(threads[2].repo).toBe("pounce-mono");
    expect(threads[2].isWorktree).toBe(true);
    expect(threads[2].worktree).toBe("salty-hibiscus");
  });

  it("abstains when a parent holds worktrees of two different repos", async () => {
    const shared = "/Users/x/worktrees";
    const a = `${shared}/from-a`;
    const b = `${shared}/from-b`;
    const orphan = `${shared}/unknown`;
    const repoB = "/Users/x/Projects/other";
    const { git } = fakeGit({
      worktrees: { [REPO]: [a], [repoB]: [b] },
      roots: { [REPO]: REPO, [repoB]: repoB },
    });
    const idx = createWorktreeIndex({
      git,
      exists: (p) => p === REPO || p === repoB,
      store: fakeStore(),
    });

    const threads = [
      { cwd: REPO, repo: "pounce-mono" },
      { cwd: repoB, repo: "other" },
      { cwd: orphan, repo: "unknown" },
    ];
    await idx.resolve(threads);

    // Two candidate projects, no way to choose — stay honest.
    expect(threads[2].repo).toBe("unknown");
  });

  it("never folds a real checkout into a neighbour's project", async () => {
    // A worktree parked directly beside real repos must not swallow them.
    const wt = "/Users/x/Projects/stray-wt";
    const neighbour = "/Users/x/Projects/unrelated";
    const { git } = fakeGit({
      worktrees: { [REPO]: [wt], [neighbour]: [] },
      roots: { [REPO]: REPO, [neighbour]: neighbour },
    });
    const idx = createWorktreeIndex({ git, exists: () => true, store: fakeStore() });

    const threads = [
      { cwd: REPO, repo: "pounce-mono" },
      { cwd: neighbour, repo: "unrelated" },
    ];
    await idx.resolve(threads);

    expect(threads[1].repo).toBe("unrelated");
    expect(threads[1].isWorktree).toBeUndefined();
  });

  it("reuses the persisted map instead of shelling out again", async () => {
    const store = fakeStore({ [SUPERSET]: "pounce-mono" });
    const { git, calls } = fakeGit({ roots: {}, worktrees: {} });
    const idx = createWorktreeIndex({ git, exists: () => true, store });

    const threads = [{ cwd: SUPERSET, repo: "v2" }];
    await idx.resolve(threads);

    expect(threads[0].repo).toBe("pounce-mono");
    expect(calls).toEqual([]); // already placed — no git at all
  });

  it("picks up a worktree created after the map was built", async () => {
    const store = fakeStore();
    const fresh = `${REPO}/.claude/worktrees/new`;
    const world = { worktrees: { [REPO]: [] }, roots: { [REPO]: REPO, [fresh]: REPO } };
    const { git } = fakeGit(world);
    const idx = createWorktreeIndex({ git, exists: () => true, store });

    await idx.resolve([{ cwd: REPO, repo: "pounce-mono" }]);
    expect(store.all()).toEqual({});

    // A repo checkout never matches an owner, so it is re-swept every pass —
    // which is what lets a brand-new worktree be discovered without a restart.
    world.worktrees[REPO] = [fresh];
    const threads = [
      { cwd: REPO, repo: "pounce-mono" },
      { cwd: fresh, repo: "new" },
    ];
    await idx.resolve(threads);

    expect(threads[1].repo).toBe("pounce-mono");
  });

  it("survives a repo that git refuses to answer for", async () => {
    const { git } = fakeGit({ worktrees: {}, roots: {} });
    const idx = createWorktreeIndex({ git, exists: () => true, store: fakeStore() });

    const threads = [{ cwd: "/not/a/repo", repo: "repo" }];
    await expect(idx.resolve(threads)).resolves.toBeDefined();
    expect(threads[0].repo).toBe("repo");
  });
});
