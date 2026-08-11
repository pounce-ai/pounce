/**
 * What the usage chart draws, and — more importantly — what it refuses to draw.
 *
 * The rule worth pinning: a series too small to see must be NAMED, not plotted.
 * A flat line on the axis and no line at all look identical, and only one of
 * them puts a colour in the legend inviting the reader to think it was zero.
 */
import { describe, expect, it } from "vitest";
import type { ActivityDay } from "../services/activity";
import { buildPlot, curvePath, niceScale, seriesPaths } from "./usageSeries";

/** A day carrying one cost and token figure per agent. */
const day = (date: string, byAgent: Record<string, { cost?: number; tokens?: number }>) =>
  ({
    date,
    sessions: 0,
    messages: 0,
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
