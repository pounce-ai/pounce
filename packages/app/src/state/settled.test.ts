/**
 * What the inbox is allowed to hide.
 *
 * Every rule here is a safety rule. An inbox that hides a thread waiting on you
 * is worse than no inbox at all, so the blockers are pinned in both directions:
 * they refuse the gesture, and they override a settle that already happened.
 */
import { describe, expect, it } from "vitest";
import type { Session } from "@pounce/shared";
import { canSettle, isBusy, isSettled, partitionSettled } from "./settled";

const session = (over: Partial<Session> = {}): Session =>
  ({
    id: "t1",
    repoId: "repo:a",
    hostId: "h1",
    host: "mac",
    agent: "claude",
    title: "A thread",
    branch: null,
    worktree: null,
    cwd: null,
    isLive: true,
    activity: "idle",
    needsAttention: false,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
    ...over,
  }) as Session;

const AFTER = "2026-08-01T11:00:00.000Z";
const BEFORE = "2026-08-01T09:00:00.000Z";

describe("a settled thread", () => {
  it("stays settled while nothing happens", () => {
    expect(isSettled(session(), AFTER)).toBe(true);
  });

  it("comes back the moment the thread is touched again", () => {
    // The whole auto-unsettle mechanism: updatedAt moved past the stamp.
    expect(isSettled(session({ updatedAt: "2026-08-01T12:00:00.000Z" }), AFTER)).toBe(false);
  });

  it("was never settled if the stamp predates the activity", () => {
    expect(isSettled(session(), BEFORE)).toBe(false);
  });

  it("is not settled without a stamp", () => {
    expect(isSettled(session(), undefined)).toBe(false);
  });
});

describe("work that outranks a settle", () => {
  it.each([
    ["awaiting_input", { activity: "awaiting_input" }],
    ["failed", { activity: "failed" }],
    ["running", { activity: "running" }],
    ["streaming", { activity: "streaming" }],
    ["queued", { activity: "queued" }],
    ["flagged as needing attention", { needsAttention: true }],
  ])("refuses to hide a thread that is %s", (_label, over) => {
    // Settled long ago, but the thread now wants something: it comes back.
    expect(isSettled(session(over as Partial<Session>), AFTER)).toBe(false);
    expect(canSettle(session(over as Partial<Session>))).toBe(false);
  });

  it("offers the gesture for a quiet thread", () => {
    expect(canSettle(session())).toBe(true);
    expect(isBusy(session())).toBe(false);
  });
});

describe("bad data never hides a thread", () => {
  it.each(["", "not-a-date", "2026-13-45T99:99:99Z"])("ignores the stamp %s", (stamp) => {
    expect(isSettled(session(), stamp)).toBe(false);
  });

  it("keeps a thread settled when the thread's own timestamp is unreadable", () => {
    // The stamp is the deliberate act; an unparseable updatedAt shouldn't undo it.
    expect(isSettled(session({ updatedAt: "nonsense" }), AFTER)).toBe(true);
  });
});

describe("partitionSettled", () => {
  it("splits the list without dropping or duplicating a thread", () => {
    const list = [session({ id: "a" }), session({ id: "b" }), session({ id: "c" })];
    const { active, settled } = partitionSettled(list, { a: AFTER, c: AFTER });
    expect(settled.map((s) => s.id)).toEqual(["a", "c"]);
    expect(active.map((s) => s.id)).toEqual(["b"]);
    expect(active.length + settled.length).toBe(list.length);
  });

  it("orders settled rows by when they were settled, newest first", () => {
    const list = [session({ id: "old" }), session({ id: "new" })];
    const { settled } = partitionSettled(list, {
      old: "2026-08-01T11:00:00.000Z",
      new: "2026-08-01T18:00:00.000Z",
    });
    // What you just cleared is what you might want back.
    expect(settled.map((s) => s.id)).toEqual(["new", "old"]);
  });

  it("leaves a busy thread in the active half however old its stamp", () => {
    const list = [session({ id: "a", activity: "running" })];
    const { active, settled } = partitionSettled(list, { a: AFTER });
    expect(active.map((s) => s.id)).toEqual(["a"]);
    expect(settled).toEqual([]);
  });

  it("keeps the order it was given for the active half", () => {
    const list = [session({ id: "a" }), session({ id: "b" }), session({ id: "c" })];
    expect(partitionSettled(list, {}).active.map((s) => s.id)).toEqual(["a", "b", "c"]);
  });
});
