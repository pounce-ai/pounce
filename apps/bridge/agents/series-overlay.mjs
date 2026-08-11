/**
 * Folding a per-day report onto the activity series.
 *
 * Three sources overlay that series — ccusage's token counts, ccusage's
 * list-price estimate, and the org's billing report — and they differ in
 * exactly one thing: what wins per field. Everything around that is identical
 * (align by date, insert days the report saw that the scan never did, re-sort,
 * re-total), and when it was written out three times it drifted: three
 * different seeds for an unseen day, two rounding rules, and only one of the
 * three recomputing a day's headline from its own rows.
 *
 * So the frame lives here once and the precedence rules stay three separate,
 * separately-documented merges. The rules are the interesting part and are
 * deliberately NOT unified — they disagree for good reasons, spelled out on
 * each one.
 *
 * All of it is pure, so `server.mjs` keeps only the fetching.
 */
import { round } from "./activity-index.mjs";

/** A day nothing was ever counted for. `cost: null` is "not knowable", which is
 *  a different claim from `0` and stays that way through every sum. */
export const emptyDay = (date) => ({
  date,
  sessions: 0,
  messages: 0,
  tokens: 0,
  cost: null,
  byAgent: {},
});

/** Per-agent row with no counts and no dollars — what an agent gets when a
 *  report knows about it but the transcript scan never saw it. */
export const emptyAgent = () => ({ sessions: 0, messages: 0, tokens: 0, cost: null });

/**
 * Apply `mergeDay` to every day the report has an entry for, and append the
 * days it saw that the series never did.
 *
 * An unseen day is seeded by running the SAME merge against an empty day, so a
 * report-only day can't take a different shape from a merged one — that
 * divergence is what the three hand-rolled copies had. Returns days in date
 * order; the caller owns the totals, which genuinely differ per overlay.
 */
export function overlayDays(series, byDay, mergeDay) {
  const out = series.days.map((d) => (byDay[d.date] ? mergeDay(d, byDay[d.date]) : d));
  const known = new Set(out.map((d) => d.date));
  for (const [date, report] of Object.entries(byDay)) {
    if (!known.has(date)) out.push(mergeDay(emptyDay(date), report));
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

/** A window total in dollars — 2dp, and null stays null. "Nobody reported" is
 *  not "$0.00", and coercing it would be the one lie this dashboard exists to
 *  avoid. */
const money = (n) => (n == null ? null : round(n, 2));

/** Sum one numeric field across days, keeping "nobody reported" as null rather
 *  than collapsing it to a confident zero. */
export function sumField(days, field) {
  let total = null;
  for (const d of days) if (d[field] != null) total = (total ?? 0) + d[field];
  return total;
}

/**
 * TOKENS — ccusage's counts replace ours, per agent.
 *
 * What counts as a token is a per-agent convention that drifts (Anthropic
 * reports cache reads beside the input, OpenAI reports them inside it), and
 * getting it wrong is invisible: a big number looks like a big number. That is
 * how the dashboard came to report 327B where Codex's own profile said 25.1B.
 * ccusage tracks ~20 agents' formats as its whole job, so it owns the reading.
 *
 * Authority is PER AGENT, not per day: an agent ccusage cannot read keeps
 * whatever the transcript scan produced rather than being zeroed by a source
 * that never had an opinion about it. For the agents it DOES read, silence on a
 * day is a real zero — which is why `reads` has to be passed in.
 */
export function mergeTokens(series, byDay, reads) {
  const days = overlayDays(series, byDay, (d, u) => {
    const out = { ...d, byAgent: { ...d.byAgent } };
    // The day's own breakdown, for the Tokens card's detail view.
    out.usage = {
      input: u.input,
      output: u.output,
      cacheCreate: u.cacheCreate,
      cacheRead: u.cacheRead,
      total: u.total,
    };
    const seen = new Set();
    for (const a of u.agents) {
      seen.add(a.agent);
      out.byAgent[a.agent] = {
        // An agent ccusage priced but we never saw still gets a row: it did
        // work, we just had no dated tokens for it.
        ...(out.byAgent[a.agent] ?? emptyAgent()),
        tokens: a.tokens,
        usage: {
          input: a.input,
          output: a.output,
          cacheCreate: a.cacheCreate,
          cacheRead: a.cacheRead,
          total: a.total,
          models: a.models,
        },
      };
    }
    for (const [agent, cur] of Object.entries(out.byAgent)) {
      if (!seen.has(agent) && reads.has(agent)) out.byAgent[agent] = { ...cur, tokens: 0 };
    }
    // The day's headline is the sum of what we just wrote, so an unreadable
    // agent (Cursor) still contributes its transcript figure.
    out.tokens = Object.values(out.byAgent).reduce((n, a) => n + (a.tokens || 0), 0);
    return out;
  });
  return {
    ...series,
    days,
    totals: { ...series.totals, tokens: days.reduce((n, d) => n + (d.tokens || 0), 0) },
    // So the client can say where the figure came from rather than implying
    // every agent was measured the same way.
    tokenSource: "ccusage",
  };
}

/**
 * ESTIMATED COST — the report's list price replaces the ledger's, per agent.
 *
 * PRECEDENCE IS BY COVERAGE, not by how official a number sounds. The report
 * reads every transcript, so for an agent it supports its figure is the whole
 * of that agent's day; the ledger (~/.pounce/usage.jsonl) only ever saw turns
 * Pounce itself DROVE, a subset. Where both have an opinion the report wins —
 * the same reasoning by which the billing report outranks the ledger below.
 *
 * That is a REVERSAL of the original rule, which filled only `cost: null` and
 * did it per DAY. One bridge-driven turn gave a day a non-null figure, and that
 * figure then blocked the estimate for everything else that happened that day.
 * Measured on a real machine: 2026-07-31 reported $19.02 of driven turns
 * against the report's $553.73, and that single day was 96% of a 30-day
 * window's error.
 *
 * Per agent, so an agent the report cannot read (Cursor) keeps its ledger
 * dollars — the same guard `mergeTokens` applies to tokens.
 */
export function mergeEstimatedCost(series, byDay) {
  let estimated = false;
  const days = overlayDays(series, byDay, (d, e) => {
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

  if (!estimated) return series;
  return {
    ...series,
    days,
    totals: {
      ...series.totals,
      cost: money(sumField(days, "cost")),
      // `costComplete` keeps its meaning — whether every agent reported its own
      // dollars — and stays false here. `costEstimated` is the separate fact
      // that some of this total was priced rather than billed.
      costEstimated: true,
    },
  };
}

/**
 * BILLED COST — the org's report replaces the day outright.
 *
 * Authoritative for dollars, so where it has a day it REPLACES rather than
 * adds: the ledger only ever saw turns Pounce drove, which are a subset of the
 * same spend. Days it doesn't cover keep whatever the ledger knew.
 *
 * Whole-day and org-wide, NOT per agent: this is the billing account's spend,
 * which may include work done outside Pounce entirely. That's the one real
 * difference from the two merges above, and why `byAgent` is left alone —
 * splitting an org total across agents would be invention.
 */
export function mergeBilledCost(series, byDay) {
  const days = overlayDays(series, byDay, (d, cost) => ({ ...d, cost }));
  return {
    ...series,
    days,
    totals: {
      ...series.totals,
      cost: money(sumField(days, "cost")),
      // The report covers the whole org for the window, so what it returns is
      // complete for the days it answered for.
      costComplete: true,
      costSource: "admin-api",
    },
  };
}
