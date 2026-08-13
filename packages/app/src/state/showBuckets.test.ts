/**
 * The Show buckets — what the Home filter is allowed to leave out.
 *
 * The property that matters is that the three buckets PARTITION the list:
 * every thread lands in exactly one, so selecting a set of chips can never
 * double-show a thread or silently drop one. The previous two-way switch failed
 * this — "Needs you" was a subset of "Everything" — which is why the two could
 * never be selected together.
 */
import { describe, expect, it } from "vitest";
import type { Session } from "@pounce/shared";
import { DEFAULT_SHOW, showBucket, showNarrowed, type ShowBucket } from "./sessionRules";

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
    updatedAt: "2026-08-10T11:00:00.000Z",
    ...over,
  }) as Session;

describe("showBucket", () => {
  it("puts a thread waiting on you in `needs`", () => {
    expect(showBucket(session({ needsAttention: true }), false)).toBe("needs");
    expect(showBucket(session({ activity: "awaiting_input" }), false)).toBe("needs");
    expect(showBucket(session({ activity: "failed" }), false)).toBe("needs");
  });

  it("puts everything else live in `active`", () => {
    expect(showBucket(session({ activity: "idle" }), false)).toBe("active");
    expect(showBucket(session({ activity: "running" }), false)).toBe("active");
    expect(showBucket(session({ activity: "completed" }), false)).toBe("active");
    // A running turn is work in flight, not work waiting on you — it belongs in
    // `active`, or "Needs you" would fill up with threads doing fine on their own.
    expect(showBucket(session({ activity: "streaming" }), false)).toBe("active");
  });

  it("puts a settled thread in `settled`", () => {
    expect(showBucket(session(), true)).toBe("settled");
  });

  it("lets settledness win over needing you, because partitionSettled already refused", () => {
    // Defence in depth rather than a real state: `isSettled` returns false for
    // anything blocked, so the caller can't hand us this pair. If it ever did,
    // ONE bucket still has to come back — a thread in two buckets would render
    // twice the moment both chips are on.
    expect(showBucket(session({ needsAttention: true }), true)).toBe("settled");
  });

  it("assigns exactly one bucket to every thread", () => {
    const all: Session[] = [
      session({ activity: "idle" }),
      session({ activity: "running" }),
      session({ activity: "failed" }),
      session({ activity: "awaiting_input" }),
      session({ needsAttention: true }),
      session({ isLive: false, activity: "completed" }),
    ];
    const buckets: ShowBucket[] = ["needs", "active", "settled"];
    for (const s of all) {
      const hits = buckets.filter((b) => showBucket(s, false) === b);
      expect(hits).toHaveLength(1);
    }
  });
});

describe("showNarrowed", () => {
  it("is false for the default pair, in either order", () => {
    expect(showNarrowed(["needs", "active"])).toBe(false);
    expect(showNarrowed(["active", "needs"])).toBe(false);
    expect(showNarrowed([...DEFAULT_SHOW])).toBe(false);
  });

  it("is true when a bucket is dropped", () => {
    expect(showNarrowed(["needs"])).toBe(true);
    expect(showNarrowed(["active"])).toBe(true);
  });

  it("is true when the archive is added — it changes which threads exist", () => {
    expect(showNarrowed(["needs", "active", "settled"])).toBe(true);
    expect(showNarrowed(["settled"])).toBe(true);
  });

  it("is true for an empty set, so the badge still points at the reason", () => {
    // The sheet stops you getting here, but state persisted by an older build
    // can be anything — an empty list must never read as "no filter applied".
    expect(showNarrowed([])).toBe(true);
  });
});

describe("DEFAULT_SHOW", () => {
  it("shows both live buckets and hides the archive", () => {
    expect([...DEFAULT_SHOW].sort()).toEqual(["active", "needs"]);
  });
});
