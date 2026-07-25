import { describe, expect, it } from "vitest";
import { contextFill } from "./contextFill";
import type { ThreadUsage } from "../services/bridge";

const usage = (over: Partial<ThreadUsage> = {}): ThreadUsage => ({
  available: true,
  contextUsed: 100_000,
  contextWindow: 200_000,
  ...over,
});

describe("contextFill", () => {
  it("computes the ratio and label from the agent's own numbers", () => {
    const f = contextFill(usage())!;
    expect(f.pct).toBe(0.5);
    expect(f.shown).toBe(50);
    expect(f.used).toBe(100_000);
    expect(f.window).toBe(200_000);
  });

  it("escalates severity at 60% and 85%", () => {
    const at = (n: number) => contextFill(usage({ contextUsed: n }))!.level;
    expect(at(119_000)).toBe("calm");
    expect(at(120_000)).toBe("warn"); // exactly 60%
    expect(at(169_000)).toBe("warn");
    expect(at(170_000)).toBe("critical"); // exactly 85%
  });

  it("clamps the arc but reports the true percentage when over the window", () => {
    // Threads can exceed the window before compaction — the ring maxes out, but
    // the label must not quietly read 100%.
    const f = contextFill(usage({ contextUsed: 240_000 }))!;
    expect(f.pct).toBe(1);
    expect(f.shown).toBe(120);
    expect(f.level).toBe("critical");
  });

  it("hides when the window is unknown", () => {
    // Claude threads with no Pounce-driven turn: fill is known, window isn't.
    // A percentage of an unknown denominator would be a fabricated number.
    expect(contextFill(usage({ contextWindow: null }))).toBeNull();
    expect(contextFill(usage({ contextWindow: 0 }))).toBeNull();
  });

  it("hides when the fill is unknown", () => {
    expect(contextFill(usage({ contextUsed: null }))).toBeNull();
    expect(contextFill(usage({ contextUsed: undefined }))).toBeNull();
  });

  it("hides for unavailable or missing usage", () => {
    expect(contextFill(null)).toBeNull();
    expect(contextFill({ available: false, reason: "unsupported-agent" })).toBeNull();
  });

  it("treats a fresh thread as empty rather than hiding", () => {
    const f = contextFill(usage({ contextUsed: 0 }))!;
    expect(f.pct).toBe(0);
    expect(f.shown).toBe(0);
    expect(f.level).toBe("calm");
  });

  it("is driven by the recent request, not the cumulative token total", () => {
    // A 60M-token thread is not 300× over a 200K window — cumulative spend and
    // context fill are different measurements and must not be conflated.
    const f = contextFill(
      usage({
        contextUsed: 90_000,
        tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0, total: 60_000_000 },
      }),
    )!;
    expect(f.shown).toBe(45);
  });
});
