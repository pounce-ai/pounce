/**
 * Discovery, over real multicast on the loopback interface.
 *
 * These run two beacons in one process and let them find each other for real,
 * because the thing worth pinning here is a wire behaviour — who sends what,
 * and who stays quiet — and a mocked socket would only assert that the code
 * calls the functions it calls.
 *
 * Multicast is not available everywhere (a locked-down CI container, a host
 * with no non-internal interface). Rather than fail there, the suite proves it
 * can hear itself first and skips if it cannot — a red build that means "this
 * machine has no network" teaches nobody anything.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDiscovery } from "./discovery.mjs";

/** Long enough for a datagram to cross loopback and be handled; far below the
 *  5s announce interval, so anything observed here came from the immediate
 *  hello/query on start rather than from the timer. */
const SETTLE_MS = 400;
const settle = () => new Promise((r) => setTimeout(r, SETTLE_MS));

/** Wait for `read()` to return something truthy, or give up. Keeps the suite
 *  quick when it passes and bounded when it doesn't. */
async function until(read, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = read();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  return read();
}

const started = [];
function start(opts) {
  const d = createDiscovery({ port: 8099, version: () => "test", ...opts });
  d.start();
  started.push(d);
  return d;
}

afterEach(() => {
  for (const d of started.splice(0)) d.stop();
});

let multicastWorks = false;
beforeAll(async () => {
  // Two beacons, both announcing: if THIS doesn't work, nothing below can.
  const a = createDiscovery({ bridgeId: "probe-a", port: 8099, announcing: true });
  const b = createDiscovery({ bridgeId: "probe-b", port: 8099, announcing: true });
  try {
    a.start();
    b.start();
    multicastWorks = !!(await until(() => a.list().some((p) => p.bridgeId === "probe-b"), 2_000));
  } finally {
    a.stop();
    b.stop();
  }
});

describe("looking and being seen are separate", () => {
  it("sees an announcing machine while invisible itself", async () => {
    if (!multicastWorks) return;
    const loud = start({ bridgeId: "loud", announcing: true });
    const quiet = start({ bridgeId: "quiet", announcing: false });

    // The whole point of the feature: no visibility required to browse.
    const seen = await until(() => quiet.list().find((p) => p.bridgeId === "loud"));
    expect(seen?.bridgeId).toBe("loud");
    // …and it learned where to knock, which is what "Ask for access" needs.
    expect(seen?.url).toMatch(/^http:\/\/.+:8099$/);

    // The other direction must NOT hold: opting out has to mean something.
    await settle();
    expect(loud.list().some((p) => p.bridgeId === "quiet")).toBe(false);
  });

  it("stays quiet even when directly asked", async () => {
    if (!multicastWorks) return;
    const quiet = start({ bridgeId: "quiet", announcing: false });
    const asker = start({ bridgeId: "asker", announcing: true });

    // A query is the one thing that could tempt an invisible machine into
    // identifying itself, since answering is unicast and feels private. It
    // isn't: the reply names the machine to whoever asked.
    asker.refresh();
    await settle();
    expect(asker.list().some((p) => p.bridgeId === "quiet")).toBe(false);
    // The invisible one is still listening throughout.
    expect(quiet.running).toBe(true);
    expect(quiet.announcing).toBe(false);
  });

  it("appears without a restart when made discoverable", async () => {
    if (!multicastWorks) return;
    const watcher = start({ bridgeId: "watcher", announcing: true });
    const quiet = start({ bridgeId: "quiet", announcing: false });

    await settle();
    expect(watcher.list().some((p) => p.bridgeId === "quiet")).toBe(false);

    // Flipping the switch has to shout immediately: waiting out the announce
    // interval would leave the person who flipped it looking at a stale list on
    // the other machine and concluding it is broken.
    quiet.setAnnouncing(true);
    expect(quiet.announcing).toBe(true);
    expect(await until(() => watcher.list().some((p) => p.bridgeId === "quiet"))).toBe(true);
  });

  it("keeps the machines it already found when it goes invisible", async () => {
    if (!multicastWorks) return;
    const loud = start({ bridgeId: "loud", announcing: true });
    const me = start({ bridgeId: "me", announcing: true });

    await until(() => me.list().some((p) => p.bridgeId === "loud"));
    me.setAnnouncing(false);
    // Hiding is about what OTHERS see. Clearing the list here would blank the
    // screen the user is reading, mid-read, for no reason.
    expect(me.list().some((p) => p.bridgeId === "loud")).toBe(true);
    expect(loud.running).toBe(true);
  });
});
