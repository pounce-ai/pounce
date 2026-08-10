/**
 * The arithmetic behind the daily usage chart — pure, so the decisions it makes
 * about what to draw can be tested without rendering anything.
 *
 * The chart layers one series per agent from a SHARED ZERO rather than stacking
 * them. Stacking puts whichever agent is drawn last permanently above the
 * others, which reads as "that one is bigger" even on days when it isn't.
 */
import type { ActivityDay } from "../services/activity";

export type UsageMetric = "cost" | "tokens";

export interface Series {
  readonly agent: string;
  /** One value per day, in the order the days were given. */
  readonly values: readonly number[];
  readonly total: number;
  /** Largest single day — what decides whether this can be seen at all. */
  readonly peak: number;
}

export interface Plot {
  /** Drawn back to front: heaviest first, so a lighter series is never buried. */
  readonly series: readonly Series[];
  /** Agents real enough to count but too small to plot at this scale. */
  readonly hidden: readonly string[];
  readonly max: number;
  readonly ticks: readonly number[];
}

/** One agent's value for one day. */
function valueOf(day: ActivityDay, agent: string, metric: UsageMetric): number {
  const a = day.byAgent?.[agent];
  if (!a) return 0;
  const v = metric === "cost" ? a.cost : a.tokens;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * A scale whose maximum is a readable 1/2/5 × 10ⁿ step at or above the peak.
 *
 * Rounding UP is the point: stopping at the last step below the peak draws the
 * tallest day past the top of the plot, where it is clipped.
 */
export function niceScale(peak: number, count: number): { max: number; ticks: number[] } {
  if (!(peak > 0)) return { max: 0, ticks: [0] };
  const rawStep = peak / count;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const n = rawStep / magnitude;
  const step = (n > 5 ? 10 : n > 2 ? 5 : n > 1 ? 2 : 1) * magnitude;
  const max = Math.ceil(peak / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 1e-6; v += step) ticks.push(v);
  return { max, ticks };
}

/**
 * Series whose peak day is below this share of the scale are not drawn.
 *
 * One agent usually dominates by orders of magnitude — a month where Claude
 * costs $6,980 and Codex costs $0.17 is ordinary. Plotting Codex there draws a
 * line indistinguishable from the axis, which is worse than not drawing it: it
 * puts a legend entry and a colour on screen for something the reader cannot
 * see, and invites them to conclude it was zero. Below the threshold the agent
 * is NAMED instead — see `hidden`.
 */
const VISIBLE_SHARE = 0.01;

/**
 * Build the plot for a window.
 *
 * `agents` fixes the colour order so a series keeps its hue as the metric
 * toggles. The scale tops out at the largest single AGENT-day, not the largest
 * day total: layered series each measure from zero, so scaling to a sum would
 * leave the plot permanently half empty.
 */
export function buildPlot(
  days: readonly ActivityDay[],
  agents: readonly string[],
  metric: UsageMetric,
  tickCount = 3,
): Plot {
  const built = agents.map((agent) => {
    const values = days.map((d) => valueOf(d, agent, metric));
    return {
      agent,
      values,
      total: values.reduce((n, v) => n + v, 0),
      peak: values.reduce((m, v) => Math.max(m, v), 0),
    };
  });

  const peak = built.reduce((m, s) => Math.max(m, s.peak), 0);
  const { max, ticks } = niceScale(peak, tickCount);

  const drawn: Series[] = [];
  const hidden: string[] = [];
  for (const s of built) {
    if (s.total <= 0) continue; // did nothing this window; not "too small", absent
    if (max > 0 && s.peak / max < VISIBLE_SHARE) hidden.push(s.agent);
    else drawn.push(s);
  }
  // Heaviest first so the lighter series is painted over it, never under.
  drawn.sort((a, b) => b.total - a.total);
  return { series: drawn, hidden, max, ticks };
}

interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * Monotone cubic tangents (Fritsch–Carlson).
 *
 * Plain cubic smoothing overshoots on spiky daily data and dips the area below
 * zero between points, which reads as negative spend. This variant is
 * shape-preserving: a smoothed series never leaves the range of its samples.
 */
function tangents(pts: readonly Point[]): number[] {
  const n = pts.length;
  if (n < 2) return [0];
  const slopes: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = pts[i + 1].x - pts[i].x;
    slopes.push(dx === 0 ? 0 : (pts[i + 1].y - pts[i].y) / dx);
  }
  const out: number[] = Array.from({ length: n }, () => 0);
  out[0] = slopes[0];
  out[n - 1] = slopes[n - 2];
  for (let i = 1; i < n - 1; i++) {
    const a = slopes[i - 1];
    const b = slopes[i];
    out[i] = a * b <= 0 ? 0 : (a + b) / 2;
  }
  for (let i = 0; i < n - 1; i++) {
    const slope = slopes[i];
    if (slope === 0) {
      out[i] = 0;
      out[i + 1] = 0;
      continue;
    }
    const a = out[i] / slope;
    const b = out[i + 1] / slope;
    const mag = a * a + b * b;
    if (mag > 9) {
      const scale = 3 / Math.sqrt(mag);
      out[i] = scale * a * slope;
      out[i + 1] = scale * b * slope;
    }
  }
  return out;
}

/** Smoothed `M…C…` path through the points. Empty for fewer than two. */
export function curvePath(pts: readonly Point[]): string {
  if (pts.length < 2) return "";
  const t = tangents(pts);
  let d = `M${pts[0].x.toFixed(2)},${pts[0].y.toFixed(2)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const dx = pts[i + 1].x - pts[i].x;
    const c1 = { x: pts[i].x + dx / 3, y: pts[i].y + (t[i] * dx) / 3 };
    const c2 = { x: pts[i + 1].x - dx / 3, y: pts[i + 1].y - (t[i + 1] * dx) / 3 };
    d += ` C${c1.x.toFixed(2)},${c1.y.toFixed(2)} ${c2.x.toFixed(2)},${c2.y.toFixed(2)} ${pts[i + 1].x.toFixed(2)},${pts[i + 1].y.toFixed(2)}`;
  }
  return d;
}

/** The line and the closed area for one series, in plot coordinates. */
export function seriesPaths(
  values: readonly number[],
  max: number,
  width: number,
  height: number,
  /** Sliver above the top gridline so a peak's stroke isn't shaved off. */
  top = 3,
): { line: string; area: string } {
  if (values.length === 0 || max <= 0) return { line: "", area: "" };
  const step = values.length === 1 ? 0 : width / (values.length - 1);
  const toY = (v: number) => height - (v / max) * (height - top);
  const line = curvePath(values.map((v, i) => ({ x: i * step, y: toY(v) })));
  return { line, area: line === "" ? "" : `${line} L${width},${height} L0,${height} Z` };
}
