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

  it("keeps a turn in flight too, so RUNNING stops flickering", () => {
    // Measured against a live bridge: `running` dropped to 0 and back on the
    // same beat a failure did. Refusing to remember it left half the flicker.
    const memo = new Map();
    for (const activity of ["running", "streaming", "queued"]) {
      expect(rememberActivity(memo, thread(), { activity })).toBe(true);
    }
  });

  it("lets an in-flight reading go stale, so it can never pin a thread", () => {
    // The danger of keeping it: enrichment only re-reads the 30 NEWEST threads,
    // so a thread that drops out of that window would assert "running" forever
    // — and isBusy() makes a running thread unsettleable, so nobody could
    // dismiss or archive it. Past the window we fall back to the guess, which
    // is wrong for one cycle instead of wrong permanently.
    const memo = new Map();
    const T0 = 1_000_000;
    rememberActivity(memo, thread(), { activity: "running" }, T0);

    const fresh = thread();
    seedActivity(memo, fresh, T0 + 30_000);
    expect(fresh.activity).toBe("running");

    const stale = thread();
    seedActivity(memo, stale, T0 + 90_000);
    expect(stale.activity).toBe("idle");
  });

  it("never lets a settled reading go stale", () => {
    // A failure stays true until the thread moves, however long that is.
    const memo = new Map();
    const T0 = 1_000_000;
    rememberActivity(memo, thread(), { activity: "failed" }, T0);
    const t = thread();
    seedActivity(memo, t, T0 + 30 * 24 * 60 * 60 * 1000);
    expect(t.activity).toBe("failed");
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
