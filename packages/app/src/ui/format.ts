/**
 * Number formatting shared by every usage/spend surface (thread header, the
 * activity dashboard, the share card) — one place so "165M" and "$61.03" read
 * identically wherever they appear.
 */

/** 165_000_000 → "165M", 1_200_000 → "1.2M", 845_000 → "845K", 900 → "900". */
export function fmtTokens(n: number): string {
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
