/**
 * Holding a message for a session another process is driving.
 *
 * The old behaviour refused outright — "wait for it to finish, then retry" —
 * which put the retry on someone holding a phone, for a turn whose end they
 * cannot see. Only the RESUME has to wait (resuming mid-turn forks a live
 * agent); the message itself can simply be held.
 *
 * The adapter's constructor builds a SessionIndex over the real ~/.claude, so
 * these call the method against a stub `this`. That is the whole point of the
 * method taking its two collaborators off `this` and its timings as arguments:
 * the waiting rule is testable without a Claude install.
 */
import { describe, it, expect } from "vitest";
import { ClaudeAdapter } from "./claude.mjs";

const wait = ClaudeAdapter.prototype.awaitForeignTurn;
const FAST = { waitMs: 300, pollMs: 10 };

/** A thread that reports busy for the first `busyPolls` checks, then settles.
 *  Both collaborators flip together, as they do on a real settled transcript. */
function stubHost(busyPolls) {
  let n = 0;
  return {
    polls: () => n,
    getActivity: async () => ({ activity: n++ < busyPolls ? "running" : "idle" }),
    isForeignWriter: async () => n <= busyPolls,
  };
}

describe("waiting out a session another process owns", () => {
  it("sends as soon as the other session goes quiet", async () => {
    const host = stubHost(2);
    const events = [];
    const ok = await wait.call(host, "t1", "s1", (e) => events.push(e), FAST);
    expect(ok).toBe(true);
    // Told once, up front — a status line per poll would be a stream of noise.
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("system_event");
    expect(events[0].level).toBe("info");
    expect(events[0].message).toMatch(/holding your message/i);
  });

  it("gives up at the cap rather than holding the turn open forever", async () => {
    const host = stubHost(Number.MAX_SAFE_INTEGER);
    const ok = await wait.call(host, "t1", "s1", () => {}, FAST);
    expect(ok).toBe(false);
    // It really polled rather than returning on the first look.
    expect(host.polls()).toBeGreaterThan(1);
  });

  it("keeps waiting while only the transcript's mtime says busy", async () => {
    // getActivity calls it idle the whole time; isForeignWriter is the one that
    // knows better. A session between two tool calls looks finished to the
    // first check, and resuming there is exactly the fork this guards.
    let n = 0;
    const host = {
      getActivity: async () => ({ activity: "idle" }),
      isForeignWriter: async () => n++ < 2,
    };
    expect(await wait.call(host, "t1", "s1", () => {}, FAST)).toBe(true);
    expect(n).toBeGreaterThan(2);
  });

  it("survives an activity probe that throws", async () => {
    let n = 0;
    const host = {
      getActivity: async () => {
        if (n++ === 0) throw new Error("transcript vanished mid-read");
        return { activity: "idle" };
      },
      isForeignWriter: async () => false,
    };
    expect(await wait.call(host, "t1", "s1", () => {}, FAST)).toBe(true);
  });
});
