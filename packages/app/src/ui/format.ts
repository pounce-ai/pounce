/**
 * Number formatting shared by every usage/spend surface (thread header, the
 * activity dashboard, the share card) — one place so "165M" and "$61.03" read
 * identically wherever they appear.
 */

/**
 * 165_000_000 → "165M", 1_200_000 → "1.2M", 845_000 → "845K", 900 → "900".
 *
 * Not tokens-specific despite the name every call site knows it by — it is the
 * app's compact number, and `fmtTokens` is the alias the usage surfaces read
 * better with. Chart axes use it for counts too: a tick reading "40,000" is
 * three characters of precision nobody reads off an axis, and it was wide
 * enough to push the plot away from its own card.
 */
export function fmtCompact(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000_000) {
    const b = n / 1_000_000_000;
    return `${b >= 100 ? Math.round(b) : b.toFixed(1).replace(/\.0$/, "")}B`;
  }
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${m >= 100 ? Math.round(m) : m.toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return `${Math.round(n)}`;
}

export const fmtTokens = fmtCompact;

/** A dollar figure for an AXIS: "$7K" where the readout would say "$7,027". */
export function fmtCostCompact(cost: number): string {
  if (!Number.isFinite(cost) || cost <= 0) return "$0";
  return cost >= 1_000 ? `$${fmtCompact(cost)}` : fmtCost(cost);
}

/** "$6.20", "$0.05", or "<$0.01" for tiny non-zero costs. Large figures lose
 *  the cents — "$10,676" is the number a person reads, not "$10676.95". */
export function fmtCost(cost: number): string {
  if (!Number.isFinite(cost)) return "$0.00";
  if (cost > 0 && cost < 0.01) return "<$0.01";
  if (cost >= 1000) return `$${Math.round(cost).toLocaleString("en-US")}`;
  return `$${cost.toFixed(2)}`;
}

/** Plain counts with thousands separators: 60708 → "60,708". */
export function fmtCount(n: number): string {
  return Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : "0";
}

/** A signed change fraction as a label: 0.42 → "+42%", -0.08 → "−8%". */
export function fmtDelta(d: number | null): string | null {
  if (d == null || !Number.isFinite(d)) return null;
  const pct = Math.round(Math.abs(d) * 100);
  if (pct === 0) return null;
  // Real minus sign — a hyphen reads as a dash next to digits.
  return `${d > 0 ? "+" : "−"}${pct}%`;
}

/** "2026-07-25" → "Jul 25". UTC-parsed so the label matches the bucket. */
export function fmtDayLabel(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return date;
  const MONTHS = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${MONTHS[m - 1]} ${d}`;
}

/** Month abbreviation for a `YYYY-MM-DD` key — the heatmap's column labels. */
export function monthOf(date: string): string {
  return fmtDayLabel(date).split(" ")[0];
}

/**
 * "2026-08-01" → "Aug '26" — a month bucket on the year chart.
 *
 * Carries the year, which `monthOf` doesn't need to: the heatmap's columns are
 * one year read left to right, but a 12-month window runs Aug→Aug, and an axis
 * labelled "Aug" at both ends says nothing about which is which.
 */
export function fmtMonthLabel(date: string): string {
  const year = date.slice(2, 4);
  return year ? `${monthOf(date)} '${year}` : monthOf(date);
}
