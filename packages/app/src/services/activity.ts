/**
 * Activity-series math — pure (no React/RN/network imports) so the dashboard's
 * arithmetic is unit-testable and can't drift from what the heatmap renders.
 *
 * The bridge returns a SPARSE series (only days that saw activity) per host.
 * Everything here works in UTC day keys ("YYYY-MM-DD") — the same keys the
 * bridge buckets by — so a device in another timezone can't shift a day.
 */

/**
 * One day of activity, as the bridge reports it.
 *
 * `cost: null` means "no agent reported a dollar figure for this day" and is
 * NOT the same as `0` — the bridge never prices tokens itself, so most history
 * has real tokens and no cost. Every helper here preserves that distinction
 * rather than coercing null to zero.
 */
export interface ActivityDay {
  readonly date: string; // YYYY-MM-DD
  readonly sessions: number;
  readonly messages: number;
  readonly tokens: number;
  readonly cost: number | null;
  readonly byAgent?: Readonly<Record<string, AgentActivity>>;
}

export interface AgentActivity {
  readonly sessions?: number;
  readonly messages?: number;
  readonly tokens?: number;
  readonly cost?: number | null;
}

export interface ActivityTotals {
  readonly sessions: number;
  readonly messages: number;
  readonly tokens: number;
  readonly cost: number | null;
  readonly costComplete: boolean;
}

/**
 * How completely a host can account for an agent:
 *   full           tokens AND agent-reported dollars
 *   tokens         token counts, but the agent states no price
 *   sessions-only  we can see it ran, nothing more
 */
export type Coverage = "full" | "tokens" | "sessions-only" | "none";

/** Best → worst, for merging what several hosts each managed to report. */
const COVERAGE_RANK: Record<Coverage, number> = {
  full: 3,
  tokens: 2,
  "sessions-only": 1,
  none: 0,
};

export interface ActivityPage {
  readonly days: readonly ActivityDay[];
  readonly totals: ActivityTotals;
  readonly coverage: Readonly<Record<string, Coverage>>;
}

/** A day plus its heatmap bucket (0 = nothing, 1–4 = quartiles). */
export interface HeatDay extends ActivityDay {
  readonly level: 0 | 1 | 2 | 3 | 4;
}

export const EMPTY_TOTALS: ActivityTotals = {
  sessions: 0,
  messages: 0,
  tokens: 0,
  cost: null,
  costComplete: true,
};

/**
 * Add two possibly-unknown dollar figures. Unknown + unknown stays unknown;
 * unknown + a real number is that number. Never treat "not reported" as 0 —
 * that is what would turn a $0 dashboard into a lie.
 */
export function addCost(a: number | null | undefined, b: number | null | undefined): number | null {
  if (a == null && b == null) return null;
  return (a ?? 0) + (b ?? 0);
}

/** UTC `YYYY-MM-DD` for a date (the bridge's bucket key). */
export function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** UTC day key `n` days before `from` (0 = that day). */
export function daysAgo(n: number, from: Date = new Date()): string {
  const d = new Date(from.getTime());
  d.setUTCDate(d.getUTCDate() - n);
  return dayKey(d);
}

function addAgent(
  dst: Record<string, AgentActivity>,
  src?: Readonly<Record<string, AgentActivity>>,
) {
  if (!src) return;
  for (const [agent, v] of Object.entries(src)) {
    const prev = dst[agent];
    dst[agent] = {
      sessions: (prev?.sessions ?? 0) + (v.sessions ?? 0),
      messages: (prev?.messages ?? 0) + (v.messages ?? 0),
      tokens: (prev?.tokens ?? 0) + (v.tokens ?? 0),
      cost: addCost(prev?.cost, v.cost),
    };
  }
}

/**
 * Merge one page per paired host into a single series.
 *
 * Days are summed per date (the same day on two machines is one day of work),
 * and coverage degrades to the WORST report: if any host can't price an agent,
 * the dashboard must say so rather than imply the total is complete.
 */
export function mergeActivity(pages: readonly (ActivityPage | null | undefined)[]): ActivityPage {
  const byDate = new Map<string, ActivityDay & { byAgent: Record<string, AgentActivity> }>();
  const totals = { ...EMPTY_TOTALS } as {
    sessions: number;
    messages: number;
    tokens: number;
    cost: number | null;
    costComplete: boolean;
  };
  const coverage: Record<string, Coverage> = {};
  for (const page of pages) {
    if (!page) continue;
    for (const day of page.days ?? []) {
      if (!day?.date) continue;
      const prev = byDate.get(day.date);
      const merged = {
        date: day.date,
        sessions: (prev?.sessions ?? 0) + (day.sessions || 0),
        messages: (prev?.messages ?? 0) + (day.messages || 0),
        tokens: (prev?.tokens ?? 0) + (day.tokens || 0),
        cost: addCost(prev?.cost, day.cost),
        byAgent: prev?.byAgent ?? {},
      };
      addAgent(merged.byAgent, day.byAgent);
      byDate.set(day.date, merged);
    }
    const t = page.totals;
    if (t) {
      totals.sessions += t.sessions || 0;
      totals.messages += t.messages || 0;
      totals.tokens += t.tokens || 0;
      totals.cost = addCost(totals.cost, t.cost);
      if (t.costComplete === false) totals.costComplete = false;
    }
    for (const [agent, c] of Object.entries(page.coverage ?? {})) {
      // Worst report wins — one host that can't price an agent means the
      // merged total isn't complete, whatever the others managed.
      const prev = coverage[agent];
      coverage[agent] = prev == null || COVERAGE_RANK[c] < COVERAGE_RANK[prev] ? c : prev;
    }
  }
  return {
    days: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
    totals,
    coverage,
  };
}

/**
 * Expand a sparse series into every day of the window, oldest first — the
 * heatmap needs a cell for quiet days too.
 */
export function zeroFill(
  days: readonly ActivityDay[],
  count: number,
  from: Date = new Date(),
): ActivityDay[] {
  const bySrc = new Map(days.map((d) => [d.date, d]));
  const out: ActivityDay[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const date = daysAgo(i, from);
    // A day with no record has no reported cost — null, not $0.
    out.push(bySrc.get(date) ?? { date, sessions: 0, messages: 0, tokens: 0, cost: null });
  }
  return out;
}

/**
 * Bucket days into GitHub-style quartiles by message count.
 *
 * Quartiles over the NON-EMPTY days only (a mostly-quiet year would otherwise
 * push every active day into the top bucket), and thresholds are strictly
 * increasing so a run of identical values can't collapse the whole ramp.
 */
export function quantize(days: readonly ActivityDay[]): HeatDay[] {
  const active = days
    .map((d) => d.messages)
    .filter((n) => n > 0)
    .sort((a, b) => a - b);
  if (!active.length) return days.map((d) => ({ ...d, level: 0 }));
  const at = (q: number) => active[Math.min(active.length - 1, Math.floor(active.length * q))];
  const t1 = at(0.25);
  const t2 = Math.max(t1 + 1, at(0.5));
  const t3 = Math.max(t2 + 1, at(0.75));
  return days.map((d) => {
    const n = d.messages;
    const level = n <= 0 ? 0 : n < t1 ? 1 : n < t2 ? 2 : n < t3 ? 3 : 4;
    return { ...d, level: level as HeatDay["level"] };
  });
}

export interface Streaks {
  readonly current: number;
  readonly longest: number;
}

/**
 * Consecutive-active-day streaks. `days` must be chronological and gap-free
 * (run it on `zeroFill` output). A quiet TODAY doesn't break the current
 * streak — the day isn't over yet — but a quiet yesterday does.
 */
export function streaks(days: readonly ActivityDay[]): Streaks {
  let longest = 0;
  let run = 0;
  for (const d of days) {
    if (d.messages > 0) {
      run++;
      if (run > longest) longest = run;
    } else run = 0;
  }
  let current = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].messages > 0) current++;
    else if (i === days.length - 1)
      continue; // today still has time
    else break;
  }
  return { current, longest };
}

export type Period = "week" | "month" | "year";

export const PERIOD_DAYS: Record<Period, number> = { week: 7, month: 30, year: 365 };

/** The last `period` worth of days, plus the equally-long window before it. */
export function periodSlice(
  days: readonly ActivityDay[],
  period: Period,
): { window: ActivityDay[]; previous: ActivityDay[] } {
  const n = PERIOD_DAYS[period];
  const window = days.slice(-n);
  const previous = days.slice(Math.max(0, days.length - 2 * n), days.length - n);
  return { window, previous };
}

/** Sum a slice. `costComplete` is the caller's concern — it's a whole-series fact. */
export function sumDays(days: readonly ActivityDay[]): Omit<ActivityTotals, "costComplete"> {
  let sessions = 0;
  let messages = 0;
  let tokens = 0;
  let cost: number | null = null;
  for (const d of days) {
    sessions += d.sessions || 0;
    messages += d.messages || 0;
    tokens += d.tokens || 0;
    cost = addCost(cost, d.cost);
  }
  return { sessions, messages, tokens, cost };
}

/**
 * Signed fraction of change vs the previous window (0.42 = +42%).
 * Null when there's no baseline to compare against — "+100%" from zero is noise.
 */
export function delta(now: number | null, before: number | null): number | null {
  if (now == null || before == null || !before) return null;
  return (now - before) / before;
}

/** Per-agent totals across a slice, biggest contributor first. */
export function byAgentTotals(
  days: readonly ActivityDay[],
): { agent: string; sessions: number; messages: number; tokens: number; cost: number | null }[] {
  const acc = new Map<
    string,
    { sessions: number; messages: number; tokens: number; cost: number | null }
  >();
  for (const d of days) {
    for (const [agent, v] of Object.entries(d.byAgent ?? {})) {
      const prev = acc.get(agent) ?? {
        sessions: 0,
        messages: 0,
        tokens: 0,
        cost: null as number | null,
      };
      acc.set(agent, {
        sessions: prev.sessions + (v.sessions ?? 0),
        messages: prev.messages + (v.messages ?? 0),
        tokens: prev.tokens + (v.tokens ?? 0),
        cost: addCost(prev.cost, v.cost),
      });
    }
  }
  return [...acc]
    .map(([agent, v]) => ({ agent, ...v }))
    .sort((a, b) => b.tokens - a.tokens || b.messages - a.messages);
}

/** Agents this host can count but not price — the dashboard's coverage caveat. */
export function partialAgents(coverage: Readonly<Record<string, Coverage>>): string[] {
  return Object.entries(coverage)
    .filter(([, c]) => c !== "full")
    .map(([agent]) => agent)
    .sort();
}
