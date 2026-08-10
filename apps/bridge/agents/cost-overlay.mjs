/**
 * Folding an estimated per-day cost report onto the activity series.
 *
 * Pure, and in its own file, because the rule it encodes is subtle and was
 * wrong for a while in a way nothing could catch: the series it merges into is
 * built from ~/.pounce/usage.jsonl, which records only the turns Pounce itself
 * DROVE, while the report covers every transcript on disk. Two sources, wildly
 * different coverage, one shared shape — and a plausible-looking merge silently
 * lost 8% of a month.
 *
 * See ./ccusage.mjs for where the report comes from and why a zero never
 * arrives here as a zero.
 */

import { round } from "./activity-index.mjs";

/** Day/agent shape with no counts and no dollars — what an agent gets when the
 *  report knows about it but the transcript scan never saw it. */
const emptyAgent = () => ({ sessions: 0, messages: 0, tokens: 0, cost: null });

/**
 * Merge `byDay` — `{ "YYYY-MM-DD": { total, byAgent: { agent: usd } } }` — into
 * an activity series.
 *
 * PRECEDENCE IS BY COVERAGE, not by how official a number sounds. The report
 * reads every transcript, so for an agent it supports its figure is the whole
 * of that agent's day; the ledger saw a subset. Where both have an opinion the
 * report wins — the same reasoning by which the org billing report outranks the
 * ledger in server.mjs's withAdminCost.
 *
 * That is a REVERSAL of the original rule, which filled only `cost: null` and
 * did it per DAY. One bridge-driven turn gave a day a non-null figure, and that
 * figure then blocked the estimate for everything else that happened that day.
 * Measured on a real machine: 2026-07-31 reported $19.02 of driven turns
 * against the report's $553.73 for the day, and that single day accounted for
 * 96% of a 30-day window's error.
 *
 * The merge is PER AGENT so an agent the report cannot read (Cursor) keeps its
 * ledger dollars rather than being zeroed by a source that never had an opinion
 * about it — the same guard withCcusageTokens applies to tokens.
 *
 * Everything the report supplied is flagged `costEstimated: true` at the level
 * it landed, so the app can mark a number as priced rather than billed.
 *
 * Returns the series unchanged when the report contributed nothing.
 */
export function mergeEstimatedCost(series, byDay) {
  let estimated = false;

  const daysOut = series.days.map((d) => {
    const e = byDay[d.date];
    if (!e) return d;
    const out = { ...d, byAgent: { ...d.byAgent } };

    // No per-agent detail to merge against: the day total is all there is, and
    // it can only be trusted where nothing is known yet.
    if (Object.keys(e.byAgent).length === 0) {
      if (out.cost == null) {
        out.cost = e.total;
        out.costEstimated = true;
        estimated = true;
      }
      return out;
    }

    let total = null;
    let anyPriced = false;
    for (const agent of new Set([...Object.keys(out.byAgent), ...Object.keys(e.byAgent)])) {
      const cur = out.byAgent[agent] ?? emptyAgent();
      const priced = e.byAgent[agent];
      const row = priced == null ? cur : { ...cur, cost: priced, costEstimated: true };
      out.byAgent[agent] = row;
      if (priced != null) anyPriced = true;
      if (row.cost != null) total = (total ?? 0) + row.cost;
    }
    // Rebuilt from the rows above rather than carried over, so a day's headline
    // and the breakdown under it can't disagree.
    out.cost = total == null ? null : round(total);
    if (anyPriced) {
      out.costEstimated = true;
      estimated = true;
    }
    return out;
  });

  // Days the report saw that the series never did — a day with spend and no
  // readable transcript still happened.
  const known = new Set(daysOut.map((d) => d.date));
  for (const [date, e] of Object.entries(byDay)) {
    if (known.has(date)) continue;
    const byAgent = {};
    for (const [agent, cost] of Object.entries(e.byAgent)) {
      byAgent[agent] = { ...emptyAgent(), cost, costEstimated: true };
    }
    daysOut.push({
      date,
      sessions: 0,
      messages: 0,
      tokens: 0,
      cost: e.total,
      costEstimated: true,
      byAgent,
    });
    estimated = true;
  }

  if (!estimated) return series;

  let total = null;
  for (const d of daysOut) if (d.cost != null) total = (total ?? 0) + d.cost;
  daysOut.sort((a, b) => a.date.localeCompare(b.date));
  return {
    ...series,
    days: daysOut,
    totals: {
      ...series.totals,
      cost: total == null ? null : round(total, 2),
      // `costComplete` keeps its meaning — whether every agent reported its own
      // dollars — and stays false here. `costEstimated` is the separate fact
      // that some of this total was priced rather than billed.
      costEstimated: true,
    },
  };
}
