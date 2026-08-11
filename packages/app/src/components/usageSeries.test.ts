/**
 * What the usage chart draws, and — more importantly — what it refuses to draw.
 *
 * The rule worth pinning: a series too small to see must be NAMED, not plotted.
 * A flat line on the axis and no line at all look identical, and only one of
 * them puts a colour in the legend inviting the reader to think it was zero.
 */
import { describe, expect, it } from "vitest";
import type { ActivityDay } from "../services/activity";
import { bucketByMonth, buildPlot, curvePath, niceScale, seriesPaths } from "./usageSeries";

/** A day carrying per-agent figures — any of the four plottable metrics. */
const day = (
  date: string,
  byAgent: Record<string, { cost?: number; tokens?: number; messages?: number; sessions?: number }>,
) =>
  ({
    date,
    sessions: Object.values(byAgent).reduce((n, a) => n + (a.sessions ?? 0), 0),
    messages: Object.values(byAgent).reduce((n, a) => n + (a.messages ?? 0), 0),
    tokens: Object.values(byAgent).reduce((n, a) => n + (a.tokens ?? 0), 0),
    cost: Object.values(byAgent).reduce((n, a) => n + (a.cost ?? 0), 0),
    byAgent,
  }) as ActivityDay;

describe("an agent that is dwarfed by another", () => {
  // The real case: a month where Claude cost $6,980 and Codex cost $0.17.
  // Codex's line is the axis. Drawing it is worse than leaving it out.
  const days = [
    day("2026-08-01", { claude: { cost: 300 }, codex: { cost: 0.08 } }),
    day("2026-08-02", { claude: { cost: 500 }, codex: { cost: 0.09 } }),
  ];

  it("is left out of the plot", () => {
    const plot = buildPlot(days, ["claude", "codex"], "cost");
    expect(plot.series.map((s) => s.agent)).toEqual(["claude"]);
  });

  it("is named instead, so it isn't read as zero", () => {
    expect(buildPlot(days, ["claude", "codex"], "cost").hidden).toEqual(["codex"]);
  });

  it("becomes visible once it's worth a pixel", () => {
    const closer = [
      day("2026-08-01", { claude: { cost: 300 }, codex: { cost: 40 } }),
      day("2026-08-02", { claude: { cost: 500 }, codex: { cost: 90 } }),
    ];
    const plot = buildPlot(closer, ["claude", "codex"], "cost");
    expect(plot.series.map((s) => s.agent)).toEqual(["claude", "codex"]);
    expect(plot.hidden).toEqual([]);
  });
});

describe("an agent that did nothing", () => {
  it("is neither drawn nor named — absent is not the same as too small", () => {
    const plot = buildPlot(
      [day("2026-08-01", { claude: { cost: 5 } })],
      ["claude", "cursor"],
      "cost",
    );
    expect(plot.series.map((s) => s.agent)).toEqual(["claude"]);
    expect(plot.hidden).toEqual([]);
  });
});

describe("draw order", () => {
  it("puts the heaviest series first so lighter ones land on top of it", () => {
    const days = [day("2026-08-01", { codex: { cost: 10 }, claude: { cost: 90 } })];
    expect(buildPlot(days, ["codex", "claude"], "cost").series.map((s) => s.agent)).toEqual([
      "claude",
      "codex",
    ]);
  });
});

describe("scale", () => {
  it("tops out at the largest single AGENT-day, not the largest day total", () => {
    // Layered series each measure from zero; scaling to 90+80 would leave the
    // plot permanently half empty.
    const days = [day("2026-08-01", { claude: { cost: 90 }, codex: { cost: 80 } })];
    const { max } = buildPlot(days, ["claude", "codex"], "cost");
    // Rounded up from the 90 peak, nowhere near the 170 they sum to.
    expect(max).toBeGreaterThanOrEqual(90);
    expect(max).toBeLessThan(170);
  });

  it("rounds up, so the tallest day is never clipped", () => {
    expect(niceScale(93, 3).max).toBeGreaterThanOrEqual(93);
    expect(niceScale(1, 3).max).toBeGreaterThanOrEqual(1);
  });

  it("has nothing to say about an empty window", () => {
    expect(niceScale(0, 3)).toEqual({ max: 0, ticks: [0] });
    expect(buildPlot([], ["claude"], "cost")).toMatchObject({ series: [], hidden: [], max: 0 });
  });
});

describe("metric", () => {
  it("reads tokens when asked for tokens", () => {
    const days = [day("2026-08-01", { claude: { cost: 5, tokens: 1_000_000 } })];
    expect(buildPlot(days, ["claude"], "tokens").series[0].values).toEqual([1_000_000]);
    expect(buildPlot(days, ["claude"], "cost").series[0].values).toEqual([5]);
  });

  it("treats an unreported figure as a gap, not a negative", () => {
    const days = [day("2026-08-01", { cursor: { tokens: 10 } })];
    // Cursor reports no dollars at all — cost is absent, not below zero.
    expect(buildPlot(days, ["cursor"], "cost").series).toEqual([]);
  });
});

describe("the smoothed path", () => {
  it("never leaves the range of its samples", () => {
    // Fritsch-Carlson is shape-preserving: a spike must not make the curve dip
    // below zero on the way in, which would draw as negative spend.
    const d = curvePath([
      { x: 0, y: 100 },
      { x: 10, y: 100 },
      { x: 20, y: 0 },
      { x: 30, y: 100 },
    ]);
    const ys = [...d.matchAll(/-?\d+\.\d+,(-?\d+\.\d+)/g)].map((m) => Number(m[1]));
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...ys)).toBeLessThanOrEqual(100);
  });

  it("is empty for a single point, rather than a stray dot", () => {
    expect(curvePath([{ x: 0, y: 0 }])).toBe("");
    expect(seriesPaths([5], 10, 100, 50).line).toBe("");
  });

  it("closes the area down to the baseline", () => {
    const { area } = seriesPaths([1, 5, 3], 5, 100, 50);
    expect(area.endsWith("L100,50 L0,50 Z")).toBe(true);
  });
});

describe("count metrics", () => {
  // The reason the bar chart went away: messages and sessions are reported per
  // agent exactly as cost and tokens are, so there was never a reason for them
  // to be drawn as one anonymous total.
  it("plots messages and sessions per agent", () => {
    const days = [
      day("2026-08-01", {
        claude: { messages: 12, sessions: 3 },
        codex: { messages: 4, sessions: 1 },
      }),
    ];
    expect(buildPlot(days, ["claude", "codex"], "messages").series.map((s) => s.values)).toEqual([
      [12],
      [4],
    ]);
    expect(buildPlot(days, ["claude", "codex"], "sessions").series.map((s) => s.values)).toEqual([
      [3],
      [1],
    ]);
  });
});

describe("a year folded to months", () => {
  it("sums each agent within a month and keeps them apart", () => {
    const folded = bucketByMonth([
      day("2026-07-01", { claude: { messages: 2, tokens: 10 } }),
      day("2026-07-20", { claude: { messages: 3, tokens: 5 }, codex: { messages: 1 } }),
      day("2026-08-04", { codex: { messages: 7 } }),
    ]);
    expect(folded.map((d) => d.date)).toEqual(["2026-07-01", "2026-08-01"]);
    expect(folded[0].byAgent?.claude.messages).toBe(5);
    expect(folded[0].byAgent?.claude.tokens).toBe(15);
    expect(folded[0].byAgent?.codex.messages).toBe(1);
    expect(folded[1].byAgent?.codex.messages).toBe(7);
    // The fold must survive the plot: this is the whole point of carrying
    // byAgent through rather than summing to a bare monthly total. Order is
    // heaviest-first as always — codex totals 8 across the two months, claude 5.
    const plotted = buildPlot(folded, ["claude", "codex"], "messages").series;
    expect(plotted.map((s) => s.agent)).toEqual(["codex", "claude"]);
    expect(plotted.map((s) => s.values)).toEqual([
      [1, 7],
      [5, 0],
    ]);
  });

  it("keeps unknown cost distinct from zero cost", () => {
    // Cursor publishes no dollars. A month of nothing-but-Cursor is "we don't
    // know", not "it was free" — summing null to 0 would invent a fact.
    const unknown = bucketByMonth([
      { date: "2026-07-01", sessions: 0, messages: 1, tokens: 0, cost: null } as ActivityDay,
      { date: "2026-07-02", sessions: 0, messages: 1, tokens: 0, cost: null } as ActivityDay,
    ]);
    expect(unknown[0].cost).toBeNull();

    const partial = bucketByMonth([
      { date: "2026-07-01", sessions: 0, messages: 1, tokens: 0, cost: null } as ActivityDay,
      { date: "2026-07-02", sessions: 0, messages: 1, tokens: 0, cost: 4 } as ActivityDay,
    ]);
    expect(partial[0].cost).toBe(4);
  });

  it("returns months in date order whatever order the days arrive in", () => {
    const folded = bucketByMonth([
      day("2026-12-01", { claude: { messages: 1 } }),
      day("2026-01-15", { claude: { messages: 1 } }),
      day("2026-06-02", { claude: { messages: 1 } }),
    ]);
    expect(folded.map((d) => d.date)).toEqual(["2026-01-01", "2026-06-01", "2026-12-01"]);
  });
});
