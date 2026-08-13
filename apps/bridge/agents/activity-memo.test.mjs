/**
 * What survives a list rebuild.
 *
 * The memo exists because re-guessing every cycle made a failed thread flicker
 * in and out of the attention shelf. These pin the other half — the readings it
 * must NOT keep, because a thread is only re-read while it is among the newest
 * 30, so anything kept here can outlive its truth by an unbounded margin.
 */
import { describe, expect, it } from "vitest";
import { forgetActivity, rememberActivity, seedActivity } from "./activity-memo.mjs";

const thread = (over = {}) => ({
  agent: "opencode",
  id: "t1",
  isLive: true,
  createdAt: "2026-08-01T00:00:00.000Z",
  ...over,
});

describe("what gets remembered", () => {
  it("keeps a settled reading", () => {
    const memo = new Map();
    for (const activity of ["failed", "completed", "idle"]) {
      expect(rememberActivity(memo, thread(), { activity, lastActivityAt: "x" })).toBe(true);
    }
  });

  it("refuses a turn that is still in flight", () => {
    // The bug this prevents: enrichment only re-reads the 30 NEWEST threads, so
    // a thread pinned as running the moment before it dropped out of that window
    // stays running forever — and isBusy() makes a running thread unsettleable,
    // so nobody could dismiss or archive it either.
    const memo = new Map();
    for (const activity of ["running", "streaming", "queued"]) {
      expect(rememberActivity(memo, thread(), { activity })).toBe(false);
    }
    expect(memo.size).toBe(0);
  });

  it("refuses a pending prompt, which is re-applied from live state", () => {
    // Remembering one would strand the thread as blocked after it was answered.
    expect(rememberActivity(new Map(), thread(), { activity: "awaiting_input" })).toBe(false);
  });

  it("ignores a reading with no activity at all", () => {
    const memo = new Map();
    expect(rememberActivity(memo, thread(), {})).toBe(false);
    expect(rememberActivity(memo, thread(), undefined)).toBe(false);
  });

  it("keys per agent, since thread ids are only unique within one", () => {
    const memo = new Map();
    rememberActivity(memo, thread({ agent: "claude" }), { activity: "failed" });
    const other = thread({ agent: "codex" });
    seedActivity(memo, other);
    expect(other.activity).toBe("idle");
  });
});

describe("seeding a freshly listed thread", () => {
  it("uses the remembered reading over the guess", () => {
    // The flicker fix itself: without this the rebuild says "idle" and the
    // attention shelf drops the thread until enrichment catches up.
    const memo = new Map();
    rememberActivity(memo, thread(), {
      activity: "failed",
      lastActivityAt: "2026-08-02T00:00:00.000Z",
    });
    const t = thread();
    seedActivity(memo, t);
    expect(t).toMatchObject({ activity: "failed", lastActivityAt: "2026-08-02T00:00:00.000Z" });
  });

  it("guesses for a thread nobody has read yet", () => {
    const t = thread();
    seedActivity(new Map(), t);
    expect(t).toMatchObject({ activity: "idle", lastActivityAt: t.createdAt });
  });

  it("falls back to createdAt when the reading carried no timestamp", () => {
    const memo = new Map();
    rememberActivity(memo, thread(), { activity: "failed" });
    const t = thread();
    seedActivity(memo, t);
    expect(t.lastActivityAt).toBe(t.createdAt);
  });

  it("calls an archived thread completed, whatever it once was", () => {
    // Its directory is gone, so nothing can happen in it — a remembered reading
    // could only be older news, and a remembered `failed` would park a thread
    // you can no longer act on in the attention shelf permanently.
    const memo = new Map();
    rememberActivity(memo, thread(), { activity: "failed" });
    const t = thread({ isLive: false });
    seedActivity(memo, t);
    expect(t.activity).toBe("completed");
  });
});

describe("forgetting", () => {
  it("drops a thread's memory", () => {
    const memo = new Map();
    rememberActivity(memo, thread(), { activity: "failed" });
    forgetActivity(memo, thread());
    const t = thread();
    seedActivity(memo, t);
    expect(t.activity).toBe("idle");
  });
});
