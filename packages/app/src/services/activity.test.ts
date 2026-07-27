import { describe, expect, it } from "vitest";
import {
  type ActivityDay,
  addCost,
  type ActivityPage,
  byAgentTotals,
  dayKey,
  daysAgo,
  delta,
  mergeActivity,
  partialAgents,
  periodSlice,
  quantize,
  streaks,
  sumDays,
  zeroFill,
} from "./activity";

// A fixed "now" so day math is deterministic (mid-day UTC, so a local-timezone
// shift can't silently move the day key).
const NOW = new Date("2026-07-25T12:00:00.000Z");

const day = (date: string, messages: number, extra: Partial<ActivityDay> = {}): ActivityDay => ({
  date,
  sessions: 0,
  messages,
  tokens: messages * 1000,
  cost: messages / 100,
  ...extra,
});

const page = (days: ActivityDay[], over: Partial<ActivityPage> = {}): ActivityPage => ({
  days,
  totals: {
    sessions: 0,
    messages: days.reduce((n, d) => n + d.messages, 0),
    tokens: days.reduce((n, d) => n + d.tokens, 0),
    cost: days.reduce<number | null>((n, d) => addCost(n, d.cost), null),
    costComplete: true,
  },
  coverage: { claude: "full" },
  ...over,
});

describe("day keys", () => {
  it("uses UTC dates so a device timezone can't shift a bucket", () => {
    expect(dayKey(new Date("2026-07-25T23:30:00.000Z"))).toBe("2026-07-25");
    expect(daysAgo(0, NOW)).toBe("2026-07-25");
    expect(daysAgo(1, NOW)).toBe("2026-07-24");
    expect(daysAgo(30, NOW)).toBe("2026-06-25");
  });

  it("crosses month and year boundaries", () => {
    expect(daysAgo(1, new Date("2026-01-01T12:00:00.000Z"))).toBe("2025-12-31");
  });
});

// The bridge never prices tokens, so "no agent reported a cost" is a real and
// common state. Collapsing it to 0 would show a confident $0 next to millions
// of tokens — the single most misleading thing this screen could do.
describe("unknown cost is not zero", () => {
  it("keeps a sum unknown when nothing reported a price", () => {
    expect(addCost(null, null)).toBeNull();
    expect(
      sumDays([day("d1", 5), day("d2", 5)].map((d) => ({ ...d, cost: null }))).cost,
    ).toBeNull();
  });

  it("treats unknown as absent, not zero, when something did report", () => {
    expect(addCost(null, 2.5)).toBe(2.5);
    const mixed = [
      { ...day("d1", 5), cost: null },
      { ...day("d2", 5), cost: 1.25 },
    ];
    expect(sumDays(mixed).cost).toBe(1.25);
  });

  it("zero-fills quiet days with an unknown cost", () => {
    expect(zeroFill([], 2, NOW).every((d) => d.cost === null)).toBe(true);
  });

  it("has no delta when either side is unknown", () => {
    expect(delta(null, 10)).toBeNull();
    expect(delta(10, null)).toBeNull();
  });

  it("merges an unknown-cost host with a reporting one", () => {
    const merged = mergeActivity([
      page([{ ...day("2026-07-24", 3), cost: null }]),
      page([{ ...day("2026-07-24", 2), cost: 0.5 }]),
    ]);
    expect(merged.days[0].cost).toBe(0.5);
  });

  it("ranks coverage worst-first across hosts", () => {
    const merged = mergeActivity([
      page([], { coverage: { claude: "full" } }),
      page([], { coverage: { claude: "tokens" } }),
    ]);
    expect(merged.coverage.claude).toBe("tokens");
  });
});

describe("mergeActivity", () => {
  it("sums the same day reported by two hosts", () => {
    const merged = mergeActivity([
      page([day("2026-07-24", 10)]),
      page([day("2026-07-24", 5), day("2026-07-25", 2)]),
    ]);
    expect(merged.days.map((d) => [d.date, d.messages])).toEqual([
      ["2026-07-24", 15],
      ["2026-07-25", 2],
    ]);
    expect(merged.totals.messages).toBe(17);
  });

  it("returns days chronologically regardless of host order", () => {
    const merged = mergeActivity([page([day("2026-07-25", 1)]), page([day("2026-07-01", 1)])]);
    expect(merged.days.map((d) => d.date)).toEqual(["2026-07-01", "2026-07-25"]);
  });

  it("merges per-agent buckets for the same day", () => {
    const merged = mergeActivity([
      page([day("2026-07-24", 10, { byAgent: { claude: { messages: 10, tokens: 100 } } })]),
      page([
        day("2026-07-24", 5, {
          byAgent: { claude: { messages: 5, tokens: 50 }, codex: { messages: 5, tokens: 20 } },
        }),
      ]),
    ]);
    expect(merged.days[0].byAgent).toEqual({
      // Neither fixture reported a price, so the merged cost stays unknown.
      claude: { sessions: 0, messages: 15, tokens: 150, cost: null },
      codex: { sessions: 0, messages: 5, tokens: 20, cost: null },
    });
  });

  it("degrades coverage to the worst host's report", () => {
    const merged = mergeActivity([
      page([], { coverage: { claude: "full", codex: "full" } }),
      page([], { coverage: { claude: "full", codex: "sessions-only" } }),
    ]);
    expect(merged.coverage).toEqual({ claude: "full", codex: "sessions-only" });
  });

  it("keeps costComplete false if any host reports a gap", () => {
    const a = page([day("2026-07-24", 1)]);
    const b = page([day("2026-07-25", 1)]);
    const merged = mergeActivity([a, { ...b, totals: { ...b.totals, costComplete: false } }]);
    expect(merged.totals.costComplete).toBe(false);
  });

  it("ignores hosts that failed to answer", () => {
    const merged = mergeActivity([null, page([day("2026-07-25", 3)]), undefined]);
    expect(merged.totals.messages).toBe(3);
  });

  it("is empty for no hosts at all", () => {
    const merged = mergeActivity([]);
    expect(merged.days).toEqual([]);
    expect(merged.totals).toMatchObject({ messages: 0, costComplete: true });
  });
});

describe("zeroFill", () => {
  it("expands a sparse series into every day, oldest first", () => {
    const filled = zeroFill([day("2026-07-25", 5), day("2026-07-23", 2)], 4, NOW);
    expect(filled.map((d) => [d.date, d.messages])).toEqual([
      ["2026-07-22", 0],
      ["2026-07-23", 2],
      ["2026-07-24", 0],
      ["2026-07-25", 5],
    ]);
  });

  it("drops days outside the window", () => {
    const filled = zeroFill([day("2020-01-01", 99)], 3, NOW);
    expect(filled).toHaveLength(3);
    expect(filled.some((d) => d.messages === 99)).toBe(false);
  });
});

describe("quantize", () => {
  it("puts quiet days at level 0 and busy days at level 4", () => {
    const out = quantize([day("d1", 0), day("d2", 1), day("d3", 5), day("d4", 20), day("d5", 100)]);
    expect(out[0].level).toBe(0);
    expect(out[4].level).toBe(4);
    // strictly non-decreasing across ascending activity
    const levels = out.slice(1).map((d) => d.level);
    expect([...levels].sort((a, b) => a - b)).toEqual(levels);
  });

  it("keeps every day at 0 when nothing happened", () => {
    expect(quantize([day("d1", 0), day("d2", 0)]).every((d) => d.level === 0)).toBe(true);
  });

  // A year of mostly-quiet days shouldn't push every active day into the top
  // bucket — quartiles are computed over active days only.
  it("spreads levels across active days in a mostly-quiet window", () => {
    const days = [
      ...Array.from({ length: 300 }, (_, i) => day(`q${i}`, 0)),
      day("a", 1),
      day("b", 10),
      day("c", 50),
      day("d", 500),
    ];
    const levels = new Set(
      quantize(days)
        .filter((d) => d.messages > 0)
        .map((d) => d.level),
    );
    expect(levels.size).toBeGreaterThan(1);
  });

  it("does not collapse the ramp when every active day is identical", () => {
    const out = quantize(Array.from({ length: 10 }, (_, i) => day(`d${i}`, 7)));
    expect(new Set(out.map((d) => d.level)).size).toBe(1);
    expect(out[0].level).toBeGreaterThan(0);
  });
});

describe("streaks", () => {
  it("counts the current run of active days", () => {
    const s = streaks([day("d1", 0), day("d2", 3), day("d3", 3), day("d4", 3)]);
    expect(s).toEqual({ current: 3, longest: 3, active: 3 });
  });

  it("counts active days regardless of whether they are consecutive", () => {
    const s = streaks([day("d1", 1), day("d2", 0), day("d3", 2), day("d4", 0), day("d5", 5)]);
    expect(s.active).toBe(3);
    expect(s.longest).toBe(1);
  });

  it("finds the longest historical run even after it breaks", () => {
    const s = streaks([day("d1", 1), day("d2", 1), day("d3", 1), day("d4", 0), day("d5", 1)]);
    expect(s.longest).toBe(3);
    expect(s.current).toBe(1);
  });

  // The day isn't over yet — a quiet today shouldn't zero out a live streak.
  it("does not break the current streak on a still-quiet today", () => {
    const s = streaks([day("d1", 1), day("d2", 1), day("today", 0)]);
    expect(s.current).toBe(2);
  });

  it("breaks the streak on a quiet yesterday", () => {
    const s = streaks([day("d1", 1), day("yesterday", 0), day("today", 0)]);
    expect(s.current).toBe(0);
  });

  it("is zero for an empty series", () => {
    expect(streaks([])).toEqual({ current: 0, longest: 0, active: 0 });
  });
});

describe("periodSlice + sumDays + delta", () => {
  const series = Array.from({ length: 20 }, (_, i) => day(`d${i}`, i + 1));

  it("returns the window and the equally-long window before it", () => {
    const { window, previous } = periodSlice(series, "week");
    expect(window).toHaveLength(7);
    expect(previous).toHaveLength(7);
    expect(window[0].date).toBe("d13");
    expect(previous[0].date).toBe("d6");
  });

  it("returns a short previous window when history is thin", () => {
    const { window, previous } = periodSlice(series.slice(0, 9), "week");
    expect(window).toHaveLength(7);
    expect(previous).toHaveLength(2);
  });

  it("sums a slice", () => {
    expect(sumDays([day("a", 2), day("b", 3)])).toMatchObject({ messages: 5, tokens: 5000 });
  });

  it("computes a signed change fraction", () => {
    expect(delta(150, 100)).toBeCloseTo(0.5);
    expect(delta(50, 100)).toBeCloseTo(-0.5);
  });

  it("has no delta without a baseline", () => {
    expect(delta(10, 0)).toBeNull();
  });
});

describe("byAgentTotals + partialAgents", () => {
  it("totals per agent, heaviest first", () => {
    const out = byAgentTotals([
      day("d1", 1, {
        byAgent: { claude: { tokens: 10, messages: 1 }, codex: { tokens: 99, messages: 1 } },
      }),
      day("d2", 1, { byAgent: { claude: { tokens: 10, messages: 1 } } }),
    ]);
    expect(out.map((a) => a.agent)).toEqual(["codex", "claude"]);
    expect(out[1]).toMatchObject({ agent: "claude", tokens: 20, messages: 2 });
  });

  it("names the agents whose spend can't be fully reported", () => {
    expect(partialAgents({ claude: "full", codex: "sessions-only", cursor: "none" })).toEqual([
      "codex",
      "cursor",
    ]);
  });

  it("is empty when every agent reports fully", () => {
    expect(partialAgents({ claude: "full" })).toEqual([]);
  });
});
