import { describe, expect, it } from "vitest";
import type { Session } from "@pounce/shared";
import {
  ATTENTION_GRACE_MS,
  ATTENTION_STALE_MS,
  needsYou,
  needsYouAt,
  rankSession,
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
    isLive: true,
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

  it("lets a failure nobody has touched since yesterday stop being urgent", () => {
    // The reported bug: threads aged 1d and 4d sitting in NEEDS ATTENTION.
    const failed = session({ activity: "failed", updatedAt: ago(ATTENTION_STALE_MS) });
    expect(needsYouAt(failed, NOW)).toBe(false);
    expect(
      needsYouAt(session({ activity: "failed", updatedAt: ago(4 * ATTENTION_STALE_MS) }), NOW),
    ).toBe(false);
  });

  it("keeps a failure urgent right up to the window", () => {
    const failed = session({ activity: "failed", updatedAt: ago(ATTENTION_STALE_MS - 1) });
    expect(needsYouAt(failed, NOW)).toBe(true);
  });

  it("never expires a thread that is actually blocked on you", () => {
    // Nothing is waiting on a failure; something IS waiting on these, so age
    // must not be allowed to quietly drop them.
    for (const s of [
      session({ activity: "awaiting_input", updatedAt: ago(30 * ATTENTION_STALE_MS) }),
      session({ needsAttention: true, updatedAt: ago(30 * ATTENTION_STALE_MS) }),
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
