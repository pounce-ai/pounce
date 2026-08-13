import { describe, expect, it } from "vitest";
import type { Session } from "@pounce/shared";
import {
  ATTENTION_GRACE_MS,
  needsYou,
  needsYouAt,
  RECENT_WINDOW_MS,
  rankSession,
  recentlyActiveAt,
} from "./sessionRules";

const NOW = Date.parse("2026-08-12T12:00:00.000Z");

function session(over: Partial<Session> = {}): Session {
  return {
    id: "t1",
    repoId: "repo:x",
    hostId: "h1",
    host: "mac",
    agent: "claude",
    title: "t",
    branch: null,
    worktree: null,
    cwd: null,
    isResumable: true,
    activity: "idle",
    needsAttention: false,
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    ...over,
  } as Session;
}

const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("needsYouAt", () => {
  it("is false for a thread in no attention state, however old", () => {
    expect(needsYouAt(session({ updatedAt: ago(60_000) }), NOW)).toBe(false);
  });

  it("holds back a thread that only just entered the state", () => {
    for (const s of [
      session({ needsAttention: true, updatedAt: ago(0) }),
      session({ activity: "failed", updatedAt: ago(1_000) }),
      session({ activity: "awaiting_input", updatedAt: ago(ATTENTION_GRACE_MS - 1) }),
    ])
      expect(needsYouAt(s, NOW)).toBe(false);
  });

  it("admits it once the grace period has elapsed", () => {
    for (const s of [
      session({ needsAttention: true, updatedAt: ago(ATTENTION_GRACE_MS) }),
      session({ activity: "failed", updatedAt: ago(ATTENTION_GRACE_MS + 1) }),
      session({ activity: "awaiting_input", updatedAt: ago(60_000) }),
    ])
      expect(needsYouAt(s, NOW)).toBe(true);
  });

  it("never hides a blocked thread behind an unparseable timestamp", () => {
    // Losing one of these is the one failure this layer must not have.
    expect(needsYouAt(session({ needsAttention: true, updatedAt: "not a date" }), NOW)).toBe(true);
  });

  it("keeps a failure urgent however old, until somebody says otherwise", () => {
    // A clock is not evidence that anyone dealt with it. Age is what ./settled's
    // dismissal is for; this layer only ever answers "is it in that state".
    const DAY = 24 * 60 * 60 * 1000;
    for (const age of [DAY, 4 * DAY, 60 * DAY])
      expect(needsYouAt(session({ activity: "failed", updatedAt: ago(age) }), NOW)).toBe(true);
  });

  it("keeps a blocked thread urgent however old", () => {
    const YEAR = 365 * 24 * 60 * 60 * 1000;
    for (const s of [
      session({ activity: "awaiting_input", updatedAt: ago(YEAR) }),
      session({ needsAttention: true, updatedAt: ago(YEAR) }),
    ])
      expect(needsYouAt(s, NOW)).toBe(true);
  });

  it("waits, rather than never firing, when the timestamp is in the future", () => {
    const future = session({
      needsAttention: true,
      updatedAt: new Date(NOW + 5_000).toISOString(),
    });
    expect(needsYouAt(future, NOW)).toBe(false);
    expect(needsYouAt(future, NOW + 5_000 + ATTENTION_GRACE_MS)).toBe(true);
  });
});

describe("needsYou", () => {
  it("takes exactly one argument, so Array.filter cannot feed it an index", () => {
    // filter passes (item, index, array); a second parameter would land on the
    // index and compare the first element against epoch 0.
    expect(needsYou.length).toBe(1);
    const list = [
      session({ id: "a", needsAttention: true, updatedAt: ago(60_000) }),
      session({ id: "b", needsAttention: true, updatedAt: ago(60_000) }),
    ];
    expect(list.filter(needsYou).map((s) => s.id)).toEqual(["a", "b"]);
  });
});

describe("rankSession", () => {
  // These read the wall clock (via needsYou), so their fixtures are anchored to
  // real time rather than the frozen NOW the pure tests above use.
  const realAgo = (ms: number) => new Date(Date.now() - ms).toISOString();

  it("ranks a settled-in attention thread above a running one", () => {
    const blocked = session({ needsAttention: true, updatedAt: realAgo(60_000) });
    const running = session({ activity: "running", updatedAt: realAgo(60_000) });
    expect(rankSession(blocked)).toBeLessThan(rankSession(running));
  });

  it("does not rank a thread as attention during its grace period", () => {
    const fresh = session({ needsAttention: true, updatedAt: new Date().toISOString() });
    expect(rankSession(fresh)).not.toBe(0);
  });
});

describe("keeping a row where you left it", () => {
  it("holds a thread's place for a few minutes after the turn stops", () => {
    // The complaint this answers: you watch a turn finish and the row you were
    // about to click has moved out of the group, into a list of two hundred.
    const justDone = session({ activity: "idle", updatedAt: ago(60_000) });
    expect(recentlyActiveAt(justDone, NOW)).toBe(true);
  });

  it("lets it go once the window has passed", () => {
    const older = session({ activity: "idle", updatedAt: ago(RECENT_WINDOW_MS + 1) });
    expect(recentlyActiveAt(older, NOW)).toBe(false);
  });

  it("always counts a turn that is actually moving", () => {
    // Even if its timestamp is stale — a long tool call reports nothing for
    // minutes, and the group would empty while the agent is mid-sentence.
    for (const activity of ["running", "streaming"] as const) {
      expect(recentlyActiveAt(session({ activity, updatedAt: ago(60 * 60_000) }), NOW)).toBe(true);
    }
  });

  it("does not hold a place on an unreadable timestamp", () => {
    // The safe direction here is the opposite of needsYou's: this only decides
    // WHERE a row sits, so guessing "recent" would pin junk to the top group.
    expect(recentlyActiveAt(session({ activity: "idle", updatedAt: "not a date" }), NOW)).toBe(
      false,
    );
  });
});
