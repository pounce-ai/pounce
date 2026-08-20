/**
 * A refresh that never comes back must not disable a feature until restart.
 *
 * `inflight` coalesces concurrent misses onto one promise and clears it in a
 * `finally`. A `fn()` that never settles never reaches that `finally`, so every
 * later request for the key joins the same dead promise — forever. It is not
 * hypothetical: after an agent CLI updated itself, /v1/quota stopped answering
 * and the plan cards read "no plan detected" until Pounce was killed and
 * restarted.
 *
 * The reads underneath all had timeouts, which is exactly why this was missed.
 * `execFile`'s timeout kills the process, but the promise settles only when its
 * stdio closes — so a CLI that leaves a child holding stdout hangs straight
 * through a timeout that looks watertight.
 *
 * This pins the behaviour against the cache in server.mjs by reimplementing it,
 * because the real one is a module-private function inside a server that binds
 * a port on import. The shape is copied deliberately: if server.mjs's version
 * changes, this test should be updated alongside it and is the record of WHY it
 * looks like this.
 */
import { describe, expect, it, vi } from "vitest";

/** The cache from server.mjs, in the shape this test is pinning. */
function makeCache({ timeoutMs = 120_000 } = {}) {
  const cache = new Map();
  const inflight = new Map();
  return async function cached(key, ttl, fn, opts = {}) {
    const ms = opts.timeoutMs ?? timeoutMs;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.value;
    const pending = inflight.get(key);
    if (pending) return pending;
    const run = (async () => {
      let timer;
      try {
        const value = await Promise.race([
          fn(),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${key}: gave up`)), ms);
          }),
        ]);
        cache.set(key, { at: Date.now(), value });
        return value;
      } finally {
        clearTimeout(timer);
        inflight.delete(key);
      }
    })();
    inflight.set(key, run);
    return run;
  };
}

describe("a read that never settles", () => {
  it("is abandoned instead of poisoning the key forever", async () => {
    vi.useFakeTimers();
    const cached = makeCache({ timeoutMs: 1000 });
    // The pathological case: a spawn whose stdio never closes.
    const hung = cached("quota", 60_000, () => new Promise(() => {}));
    const settled = hung.catch((e) => e.message);
    await vi.advanceTimersByTimeAsync(1001);
    expect(await settled).toContain("gave up");

    // ...and the NEXT caller gets a fresh read rather than joining the dead one.
    // This is the whole bug: without it, every later request returned the same
    // never-resolving promise and only a restart cleared it.
    vi.useRealTimers();
    await expect(cached("quota", 60_000, async () => "fresh")).resolves.toBe("fresh");
  });

  it("still coalesces concurrent callers onto one read", async () => {
    const cached = makeCache();
    let runs = 0;
    const slow = async () => {
      runs += 1;
      await new Promise((r) => setTimeout(r, 10));
      return runs;
    };
    const [a, b, c] = await Promise.all([
      cached("k", 60_000, slow),
      cached("k", 60_000, slow),
      cached("k", 60_000, slow),
    ]);
    // Coalescing is why the timeout had to be added rather than the map removed:
    // one slow refresh must still serve every caller waiting on it.
    expect([a, b, c]).toEqual([1, 1, 1]);
    expect(runs).toBe(1);
  });

  it("serves the cached value without re-reading, and a failure is not cached", async () => {
    const cached = makeCache({ timeoutMs: 50 });
    await cached("k", 60_000, async () => "first");
    await expect(cached("k", 60_000, async () => "second")).resolves.toBe("first");

    const boom = cached("bad", 60_000, () => new Promise(() => {}));
    await expect(boom).rejects.toThrow();
    // A timed-out read must leave nothing behind: the next call re-reads.
    await expect(cached("bad", 60_000, async () => "recovered")).resolves.toBe("recovered");
  });
});
