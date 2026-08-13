/**
 * Reclaiming disk: what gets counted, who gets blamed for it, and — the part
 * that matters — what this refuses to delete.
 *
 * The removal path is the only place in the bridge that destroys a directory on
 * request, so the tests that earn their keep are the refusals: a path nobody
 * indexed, and a worktree with work in it that nobody has committed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { forgetSize, readDisk, removeWorktree } from "./disk.mjs";

const WT = "/ws/feature-a";
const WT2 = "/ws/feature-b";
const OWNERS = { [WT]: "pounce", [WT2]: "pounce" };

const DAY = 86_400_000;
const NOW = Date.parse("2026-08-13T12:00:00.000Z");

/** A git that answers per-subcommand, and records what it was asked to do. */
function fakeGit({ dirty = 0, branch = "feature-a", unpushed = 0, removeFails = false } = {}) {
  const calls = [];
  const git = vi.fn(async (cwd, args) => {
    calls.push([cwd, args.join(" ")]);
    if (args[0] === "rev-parse") return { code: 0, out: `${branch}\n`, err: "" };
    if (args[0] === "status")
      return {
        code: 0,
        out: Array.from({ length: dirty }, (_, i) => ` M f${i}`).join("\n"),
        err: "",
      };
    if (args[0] === "rev-list") return { code: 0, out: `${unpushed}\n`, err: "" };
    if (args[0] === "worktree" && args[1] === "remove")
      return removeFails ? { code: 1, out: "", err: "no" } : { code: 0, out: "", err: "" };
    return { code: 0, out: "", err: "" };
  });
  return { git, calls };
}

/** `du -sk` answering in kilobytes, keyed by directory. */
const fakeExec = (kb) =>
  vi.fn(async (_cmd, args) => ({ code: 0, out: `${kb[args[1]] ?? 0}\t${args[1]}\n`, err: "" }));

const thread = (over) => ({
  id: "t1",
  agent: "claude",
  cwd: WT,
  createdAt: "2026-08-01T00:00:00.000Z",
  ...over,
});

beforeEach(() => forgetSize());

describe("readDisk", () => {
  const base = () => ({
    owners: OWNERS,
    git: fakeGit().git,
    exec: fakeExec({ [WT]: 2048, [WT2]: 1024 }),
    exists: () => true,
    now: NOW,
  });

  it("sizes each worktree and totals them, biggest first", async () => {
    const r = await readDisk(base());
    expect(r.worktrees.map((w) => [w.name, w.bytes])).toEqual([
      ["feature-a", 2048 * 1024],
      ["feature-b", 1024 * 1024],
    ]);
    expect(r.totalBytes).toBe(3072 * 1024);
    expect(r.unmeasured).toBe(0);
  });

  it("credits the agent whose thread ran there last, not the path's shape", async () => {
    const r = await readDisk({
      ...base(),
      threads: [
        thread({ id: "old", agent: "codex", createdAt: "2026-07-01T00:00:00.000Z" }),
        thread({ id: "new", agent: "claude", lastActivityAt: "2026-08-10T00:00:00.000Z" }),
      ],
    });
    const a = r.worktrees.find((w) => w.path === WT);
    expect(a.agent).toBe("claude");
    expect(a.threads).toBe(2);
    expect(a.lastThreadId).toBe("new");
    expect(a.idleDays).toBe(3);
  });

  it("keeps unclaimed worktrees in their own bucket rather than blaming an agent", async () => {
    const r = await readDisk({ ...base(), threads: [thread({ agent: "claude" })] });
    expect(r.agents).toEqual([
      { agent: "claude", bytes: 2048 * 1024, worktrees: 1 },
      { agent: null, bytes: 1024 * 1024, worktrees: 1 },
    ]);
  });

  it("counts a thread in a SUBDIRECTORY of the worktree as belonging to it", async () => {
    const r = await readDisk({ ...base(), threads: [thread({ cwd: `${WT}/packages/app` })] });
    expect(r.worktrees.find((w) => w.path === WT).threads).toBe(1);
  });

  it("skips index entries whose directory is already gone", async () => {
    const r = await readDisk({ ...base(), exists: (p) => p === WT });
    expect(r.worktrees.map((w) => w.path)).toEqual([WT]);
  });

  it("dates an unworked worktree by its own mtime, not by nothing", async () => {
    const r = await readDisk({ ...base(), threads: [] });
    // Falls through to statSync on a path that doesn't exist in this test →
    // null, which must stay null rather than becoming "0 days idle".
    expect(r.worktrees[0].idleDays).toBe(null);
  });

  it("reports a size it could not measure as unknown, never as zero", async () => {
    const r = await readDisk({
      ...base(),
      exec: vi.fn(async () => ({ code: 1, out: "", err: "du: permission denied" })),
    });
    expect(r.worktrees.every((w) => w.bytes === null)).toBe(true);
    expect(r.unmeasured).toBe(2);
    expect(r.totalBytes).toBe(0);
  });

  it("measures a tree once, however often the report is read", async () => {
    const exec = fakeExec({ [WT]: 2048, [WT2]: 1024 });
    await readDisk({ ...base(), exec });
    await readDisk({ ...base(), exec });
    expect(exec).toHaveBeenCalledTimes(2); // two worktrees, one pass
  });

  it("carries the uncommitted count and unpushed commits per worktree", async () => {
    const r = await readDisk({ ...base(), git: fakeGit({ dirty: 3, unpushed: 2 }).git });
    expect(r.worktrees[0]).toMatchObject({ dirtyFiles: 3, unpushed: 2, branch: "feature-a" });
  });
});

describe("removeWorktree", () => {
  const base = () => ({
    owners: OWNERS,
    exists: () => true,
    rm: vi.fn(async () => {}),
    repoRootOf: async () => "/repo",
  });

  it("refuses any path the index doesn't know as a worktree", async () => {
    const { git, calls } = fakeGit();
    for (const p of ["/Users/me", "/repo", "/ws/feature-a/../..", ""]) {
      expect(await removeWorktree({ ...base(), path: p, git })).toEqual({
        ok: false,
        reason: "unknown",
      });
    }
    // Nothing was even inspected, let alone removed.
    expect(calls).toEqual([]);
  });

  it("refuses a dirty worktree, and hands back the thread to open instead", async () => {
    const { git } = fakeGit({ dirty: 4 });
    const r = await removeWorktree({
      ...base(),
      path: WT,
      git,
      threads: [thread({ id: "t9", agent: "codex", lastActivityAt: "2026-08-12T00:00:00.000Z" })],
    });
    expect(r).toMatchObject({
      ok: false,
      reason: "dirty",
      dirtyFiles: 4,
      lastThreadId: "t9",
      lastThreadAgent: "codex",
    });
  });

  // The case that actually exists on a real machine: a worktree git has
  // forgotten (its admin entry pruned) fails every git command here. Reading
  // that silence as "clean" would delete a folder nobody has checked.
  it("refuses when git can't say whether there's uncommitted work", async () => {
    const git = vi.fn(async (_cwd, args) =>
      args[0] === "status"
        ? { code: 128, out: "", err: "fatal: not a git repository" }
        : { code: 0, out: "", err: "" },
    );
    const rm = vi.fn(async () => {});
    const r = await removeWorktree({ ...base(), path: WT, git, rm });
    expect(r).toMatchObject({ ok: false, reason: "dirty", dirtyFiles: null });
    expect(rm).not.toHaveBeenCalled();
  });

  it("removes a dirty worktree when the user said so", async () => {
    const { git, calls } = fakeGit({ dirty: 4 });
    const r = await removeWorktree({ ...base(), path: WT, git, force: true });
    expect(r.ok).toBe(true);
    expect(calls).toContainEqual(["/repo", `worktree remove --force ${WT}`]);
    expect(calls).toContainEqual(["/repo", "worktree prune"]);
  });

  it("keeps the branch unless deleting it was asked for", async () => {
    const { git, calls } = fakeGit();
    const kept = await removeWorktree({ ...base(), path: WT, git });
    expect(kept).toMatchObject({ ok: true, branch: "feature-a", branchDeleted: false });
    expect(calls.some(([, a]) => a.startsWith("branch -D"))).toBe(false);

    const gone = fakeGit();
    const r = await removeWorktree({ ...base(), path: WT, git: gone.git, deleteBranch: true });
    expect(r.branchDeleted).toBe(true);
    expect(gone.calls).toContainEqual(["/repo", "branch -D feature-a"]);
  });

  it("falls back to deleting the directory when git won't", async () => {
    const { git } = fakeGit({ removeFails: true });
    let live = true;
    const rm = vi.fn(async () => {
      live = false;
    });
    const r = await removeWorktree({ ...base(), path: WT, git, rm, exists: () => live });
    expect(rm).toHaveBeenCalledWith(WT);
    expect(r.ok).toBe(true);
  });

  it("reports failure rather than success when the directory survives", async () => {
    const { git } = fakeGit({ removeFails: true });
    const r = await removeWorktree({
      ...base(),
      path: WT,
      git,
      rm: vi.fn(async () => {
        throw new Error("EPERM");
      }),
    });
    expect(r).toMatchObject({ ok: false, reason: "failed" });
  });

  it("says so when the directory is already gone", async () => {
    const r = await removeWorktree({
      ...base(),
      path: WT,
      git: fakeGit().git,
      exists: () => false,
    });
    expect(r).toEqual({ ok: false, reason: "gone" });
  });
});

/** The clock the idle-days test leans on, kept honest. */
it("counts idle days from the last activity", async () => {
  const r = await readDisk({
    owners: { [WT]: "pounce" },
    git: fakeGit().git,
    exec: fakeExec({ [WT]: 1 }),
    exists: () => true,
    now: NOW,
    threads: [thread({ lastActivityAt: new Date(NOW - 10 * DAY).toISOString() })],
  });
  expect(r.worktrees[0].idleDays).toBe(10);
});
