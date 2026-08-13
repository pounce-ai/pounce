/**
 * What the inbox is allowed to hide.
 *
 * Every rule here is a safety rule. An inbox that hides a thread waiting on you
 * is worse than no inbox at all, so the blockers are pinned in both directions:
 * they refuse the gesture, and they override anything already recorded.
 */
import { describe, expect, it } from "vitest";
import type { Session } from "@pounce/shared";
import {
  canSettle,
  isBusy,
  isSettled,
  partitionSettled,
  type SettleOptions,
  type SettleOverride,
} from "./settled";

const NOW = "2026-08-10T12:00:00.000Z";
/** Default policy: three quiet days, as T3 Code does it. */
const OPTS: SettleOptions = { now: NOW, autoSettleAfterDays: 3 };
const NO_AUTO: SettleOptions = { now: NOW, autoSettleAfterDays: null };

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
    // An hour ago: recent enough that auto-settle never fires by accident.
    updatedAt: "2026-08-10T11:00:00.000Z",
    ...over,
  }) as Session;

const settledAt = (at: string): SettleOverride => ({ state: "settled", at });
const activeAt = (at: string): SettleOverride => ({ state: "active", at });

const LATER = "2026-08-10T11:30:00.000Z";
const EARLIER = "2026-08-10T10:00:00.000Z";
/** Older than the auto-settle window. */
const stale = session({ updatedAt: "2026-08-01T00:00:00.000Z" });

describe("an explicit settle", () => {
  it("holds while nothing happens", () => {
    expect(isSettled(session(), settledAt(LATER), OPTS)).toBe(true);
  });

  it("is overtaken the moment the thread is touched again", () => {
    // Auto-unsettle: the override predates the thread's own last activity.
    expect(isSettled(session(), settledAt(EARLIER), OPTS)).toBe(false);
  });

  it("is not needed for a thread nobody has an opinion about", () => {
    expect(isSettled(session(), undefined, OPTS)).toBe(false);
  });
});

describe("auto-settle", () => {
  it("settles a thread that has been quiet past the window", () => {
    expect(isSettled(stale, undefined, OPTS)).toBe(true);
  });

  it("leaves a recent thread alone", () => {
    expect(isSettled(session(), undefined, OPTS)).toBe(false);
  });

  it("does nothing when switched off", () => {
    expect(isSettled(stale, undefined, NO_AUTO)).toBe(false);
  });

  it("respects a longer window", () => {
    expect(isSettled(stale, undefined, { now: NOW, autoSettleAfterDays: 30 })).toBe(false);
  });
});

/**
 * The reason an override records a DIRECTION rather than a boolean. Without a
 * storable "active", pulling an old thread back out would do nothing: the
 * inactivity rule would settle it again on the same render.
 */
describe("keeping an old thread out of the drawer", () => {
  it("holds a stale thread active when the user says so", () => {
    expect(isSettled(stale, activeAt(NOW), OPTS)).toBe(false);
  });

  it("lets it settle again once the thread moves on", () => {
    // The keep-active is older than the thread's own last activity, so it has
    // been overtaken — and the thread is quiet again.
    const touched = session({ updatedAt: "2026-08-02T00:00:00.000Z" });
    expect(isSettled(touched, activeAt("2026-08-01T00:00:00.000Z"), OPTS)).toBe(true);
  });
});

describe("work that outranks anything recorded", () => {
  it.each([
    ["awaiting_input", { activity: "awaiting_input" }],
    ["running", { activity: "running" }],
    ["streaming", { activity: "streaming" }],
    ["queued", { activity: "queued" }],
    ["flagged as needing attention", { needsAttention: true }],
  ])("refuses to hide a thread that is %s", (_label, over) => {
    // Anchored to the WALL clock, not the frozen NOW above: isBusy asks needsYou,
    // which reads Date.now(), and a failure only reads as fresh in real time.
    const touched = new Date(Date.now() - 60_000).toISOString();
    const cleared = new Date(Date.now() - 30_000).toISOString();
    const busy = session({ ...(over as Partial<Session>), updatedAt: touched });
    expect(isSettled(busy, settledAt(cleared), OPTS)).toBe(false);
    expect(canSettle(busy)).toBe(false);
  });

  it.each([
    ["awaiting_input", { activity: "awaiting_input" }],
    ["running", { activity: "running" }],
    ["streaming", { activity: "streaming" }],
    ["queued", { activity: "queued" }],
    ["flagged as needing attention", { needsAttention: true }],
  ])("keeps auto-settle away from a thread that is %s, however old", (_label, over) => {
    const old = session({ ...(over as Partial<Session>), updatedAt: "2026-01-01T00:00:00.000Z" });
    expect(isSettled(old, undefined, OPTS)).toBe(false);
  });

  it("lets the user dismiss a failure, and offers the gesture for one", () => {
    // The asymmetry this rule exists for: a failure is finished, so "I've seen
    // it" is a real answer. Nothing is waiting on it the way something waits on
    // an awaiting_input thread, which the case above still protects absolutely.
    const touched = new Date(Date.now() - 60_000).toISOString();
    const cleared = new Date(Date.now() - 30_000).toISOString();
    const failed = session({ activity: "failed", updatedAt: touched });
    expect(canSettle(failed)).toBe(true);
    expect(isSettled(failed, settledAt(cleared), OPTS)).toBe(true);
  });

  it("brings a dismissed failure back if it fails again", () => {
    // Free, via `stale`: the thread moving past the dismissal discards it. This
    // is what makes acknowledging safe — you are clearing THIS failure, not
    // muting the thread.
    const cleared = new Date(Date.now() - 60_000).toISOString();
    const touchedSince = new Date(Date.now() - 30_000).toISOString();
    const failed = session({ activity: "failed", updatedAt: touchedSince });
    expect(isSettled(failed, settledAt(cleared), OPTS)).toBe(false);
  });

  it("never lets the CLOCK file a failure nobody dismissed", () => {
    // The rejected design: a max age after which the shelf quietly drops it. A
    // shelf that files things on a timer is one you cannot trust to be complete.
    const old = session({ activity: "failed", updatedAt: "2026-01-01T00:00:00.000Z" });
    expect(isSettled(old, undefined, OPTS)).toBe(false);
  });

  it("offers the gesture for a quiet thread", () => {
    expect(canSettle(session())).toBe(true);
    expect(isBusy(session())).toBe(false);
  });
});

describe("bad data never hides a thread", () => {
  it.each(["", "not-a-date", "2026-13-45T99:99:99Z"])("ignores the stamp %s", (at) => {
    expect(isSettled(session(), settledAt(at), OPTS)).toBe(false);
  });

  it("keeps a deliberate settle when the thread's own timestamp is unreadable", () => {
    expect(isSettled(session({ updatedAt: "nonsense" }), settledAt(LATER), OPTS)).toBe(true);
  });

  it("won't auto-settle a thread whose timestamp it can't read", () => {
    expect(isSettled(session({ updatedAt: "nonsense" }), undefined, OPTS)).toBe(false);
  });
});

describe("partitionSettled", () => {
  it("splits the list without dropping or duplicating a thread", () => {
    const list = [session({ id: "a" }), session({ id: "b" }), session({ id: "c" })];
    const { active, settled } = partitionSettled(
      list,
      { a: settledAt(LATER), c: settledAt(LATER) },
      OPTS,
    );
    expect(settled.map((s) => s.id)).toEqual(["a", "c"]);
    expect(active.map((s) => s.id)).toEqual(["b"]);
    expect(active.length + settled.length).toBe(list.length);
  });

  it("puts what you just cleared at the top", () => {
    const list = [session({ id: "old" }), session({ id: "new" })];
    const { settled } = partitionSettled(
      list,
      { old: settledAt("2026-08-10T11:10:00.000Z"), new: settledAt("2026-08-10T11:50:00.000Z") },
      OPTS,
    );
    expect(settled.map((s) => s.id)).toEqual(["new", "old"]);
  });

  it("leaves a busy thread in the active half however old its override", () => {
    const list = [session({ id: "a", activity: "running" })];
    const { active, settled } = partitionSettled(list, { a: settledAt(LATER) }, OPTS);
    expect(active.map((s) => s.id)).toEqual(["a"]);
    expect(settled).toEqual([]);
  });

  it("keeps the order it was given for the active half", () => {
    const list = [session({ id: "a" }), session({ id: "b" }), session({ id: "c" })];
    expect(partitionSettled(list, {}, OPTS).active.map((s) => s.id)).toEqual(["a", "b", "c"]);
  });

  it("clears a backlog on its own — the reason auto-settle is on by default", () => {
    // A year of history with a handful of live threads: the inbox has to open
    // in a usable state without anyone hand-clearing hundreds of rows.
    const old = Array.from({ length: 200 }, (_, i) =>
      session({ id: `old${i}`, updatedAt: "2026-06-01T00:00:00.000Z" }),
    );
    const live = Array.from({ length: 6 }, (_, i) => session({ id: `live${i}` }));
    const { active, settled } = partitionSettled([...old, ...live], {}, OPTS);
    expect(active).toHaveLength(6);
    expect(settled).toHaveLength(200);
  });
});
