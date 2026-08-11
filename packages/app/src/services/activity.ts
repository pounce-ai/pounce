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
 * `cost: null` means "nothing could put a dollar figure on this day" and is NOT
 * the same as `0`. Every helper here preserves that distinction rather than
 * coercing null to zero.
 *
 * `costEstimated` marks a figure the bridge PRICED rather than one somebody
 * BILLED: tokens × public list rates, via ccusage. It's a different kind of
 * number and the UI must show it as one — on a subscription plan the true
 * marginal cost of those tokens is zero. The flag is sticky through every sum
 * below: mixing one estimate into a total makes the total an estimate.
 */
export interface ActivityDay {
  readonly date: string; // YYYY-MM-DD
  readonly sessions: number;
  readonly messages: number;
  readonly tokens: number;
  readonly cost: number | null;
  readonly costEstimated?: boolean;
  readonly byAgent?: Readonly<Record<string, AgentActivity>>;
  /** Per repository. Sessions and messages only — see RepoActivity. */
  readonly byRepo?: Readonly<Record<string, RepoActivity>>;
  readonly usage?: TokenUsage;
}

/**
 * What a space did, as the bridge can honestly attribute it.
 *
 * No tokens and no cost on purpose. Both now come from host-wide sources
 * (ccusage for tokens, the billing report for dollars) that report per day
 * across everything and can't say which repo a figure belongs to. Sessions and
 * messages come from thread metadata, which does know.
 */
export interface RepoActivity {
  readonly sessions?: number;
  readonly messages?: number;
}

export interface AgentActivity {
  readonly sessions?: number;
  readonly messages?: number;
  readonly tokens?: number;
  readonly cost?: number | null;
  readonly costEstimated?: boolean;
  readonly usage?: TokenUsage;
}

/**
 * The columns behind a `tokens` figure — how the reported total breaks down.
 *
 * `tokens` equals `total`: the headline is the agent's OWN reported number, not
 * a derived one. The four columns explain its composition; they never adjust it.
 *
 * The distinction worth surfacing is `cacheRead` (context re-sent from cache)
 * versus everything else (fresh input, output, and cache writes). It runs from
 * ~78% to ~98% of the total depending on the agent, so a reader who assumes the
 * headline is all new input is badly wrong about what the number means — which
 * is why the UI shows the cached share beside it rather than subtracting it.
 */
export interface TokenUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheCreate: number;
  readonly cacheRead: number;
  readonly total: number;
  readonly models?: readonly ModelUsage[];
}

export interface ModelUsage extends TokenUsage {
  readonly model: string;
  readonly tokens: number;
  readonly cost: number | null;
}

/**
 * One model, and the AGENT that ran it.
 *
 * Agent and model are two different axes: Claude Code, Codex, opencode and
 * Cursor are agents; `claude-opus-5` and `gpt-5.5` are models. An agent is not
 * tied to one vendor's models — Codex and opencode both run `gpt-5.5` — so a
 * model NAME is not a unique row. Only the pair is, which is why this type
 * exists rather than a bare ModelUsage: flattening on the name alone silently
 * merged two real rows onto one.
 */
export interface ModelRow extends ModelUsage {
  readonly agent: string;
}

export interface ActivityTotals {
  readonly sessions: number;
  readonly messages: number;
  readonly tokens: number;
  readonly cost: number | null;
  readonly costComplete: boolean;
  readonly costEstimated?: boolean;
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

/**
 * Sum two token breakdowns — the same day on two machines is one day of work,
 * and its columns add like any other counter.
 *
 * Absent on both sides stays absent: a `usage` of all zeros would claim the
 * breakdown is known and empty, when what we mean is that nobody reported one
 * (a host with no ccusage, or an agent it can't read).
 */
function addUsage(a?: TokenUsage, b?: TokenUsage): TokenUsage | undefined {
  if (!a) return b;
  if (!b) return a;
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheCreate: a.cacheCreate + b.cacheCreate,
    cacheRead: a.cacheRead + b.cacheRead,
    total: a.total + b.total,
    models: mergeModels(a.models, b.models),
  };
}

/** Same model on two hosts is one row; anything else appends. */
function mergeModels(
  a?: readonly ModelUsage[],
  b?: readonly ModelUsage[],
): readonly ModelUsage[] | undefined {
  if (!a?.length) return b;
  if (!b?.length) return a;
  const by = new Map<string, ModelUsage>();
  for (const m of [...a, ...b]) {
    const prev = by.get(m.model);
    by.set(
      m.model,
      prev
        ? {
            ...prev,
            tokens: prev.tokens + m.tokens,
            input: prev.input + m.input,
            output: prev.output + m.output,
            cacheCreate: prev.cacheCreate + m.cacheCreate,
            cacheRead: prev.cacheRead + m.cacheRead,
            total: prev.total + m.total,
            cost: addCost(prev.cost, m.cost),
          }
        : m,
    );
  }
  return [...by.values()].sort((x, y) => y.tokens - x.tokens);
}

function addRepo(dst: Record<string, RepoActivity>, src?: Readonly<Record<string, RepoActivity>>) {
  if (!src) return;
  for (const [repo, v] of Object.entries(src)) {
    const prev = dst[repo];
    dst[repo] = {
      sessions: (prev?.sessions ?? 0) + (v.sessions ?? 0),
      messages: (prev?.messages ?? 0) + (v.messages ?? 0),
    };
  }
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
      costEstimated: prev?.costEstimated || v.costEstimated,
      usage: addUsage(prev?.usage, v.usage),
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
  const byDate = new Map<
    string,
    ActivityDay & { byAgent: Record<string, AgentActivity>; byRepo: Record<string, RepoActivity> }
  >();
  const totals = { ...EMPTY_TOTALS };
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
        costEstimated: prev?.costEstimated || day.costEstimated,
        byAgent: prev?.byAgent ?? {},
        byRepo: prev?.byRepo ?? {},
        usage: addUsage(prev?.usage, day.usage),
      };
      addAgent(merged.byAgent, day.byAgent);
      addRepo(merged.byRepo, day.byRepo);
      byDate.set(day.date, merged);
    }
    const t = page.totals;
    if (t) {
      totals.sessions += t.sessions || 0;
      totals.messages += t.messages || 0;
      totals.tokens += t.tokens || 0;
      totals.cost = addCost(totals.cost, t.cost);
      if (t.costComplete === false) totals.costComplete = false;
      if (t.costEstimated) totals.costEstimated = true;
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
  /** Days with any activity. Counted here because this already walks the array
   *  — the dashboard would otherwise re-filter 365 days in its render body. */
  readonly active: number;
}

/**
 * Consecutive-active-day streaks. `days` must be chronological and gap-free
 * (run it on `zeroFill` output). A quiet TODAY doesn't break the current
 * streak — the day isn't over yet — but a quiet yesterday does.
 */
export function streaks(days: readonly ActivityDay[]): Streaks {
  let longest = 0;
  let run = 0;
  let active = 0;
  for (const d of days) {
    if (d.messages > 0) {
      active++;
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
  return { current, longest, active };
}

export type Period = "week" | "month" | "year";

export const PERIOD_DAYS: Record<Period, number> = { week: 7, month: 30, year: 365 };

/** The picker's label for a period. Lives beside PERIOD_DAYS because four
 *  screens render the same three buttons and had four copies of this. */
export const PERIOD_LABEL: Record<Period, string> = { week: "Week", month: "Month", year: "Year" };

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

/** Sum a slice. `costComplete` is the caller's concern — it's a whole-series fact.
 *  `costEstimated` is not: it belongs to whichever days landed in THIS slice. */
export function sumDays(days: readonly ActivityDay[]): Omit<ActivityTotals, "costComplete"> {
  let sessions = 0;
  let messages = 0;
  let tokens = 0;
  let cost: number | null = null;
  let costEstimated = false;
  for (const d of days) {
    sessions += d.sessions || 0;
    messages += d.messages || 0;
    tokens += d.tokens || 0;
    cost = addCost(cost, d.cost);
    if (d.costEstimated && d.cost != null) costEstimated = true;
  }
  return { sessions, messages, tokens, cost, costEstimated };
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
  /** Agents to list even with no activity in this window, zero-filled. The
   *  dashboard passes every agent it knows about so this table and the plan
   *  card describe the same set — two lists of different agents on one screen
   *  reads as a bug, not as two questions. */
  include: readonly string[] = [],
): {
  agent: string;
  sessions: number;
  messages: number;
  tokens: number;
  cost: number | null;
  costEstimated: boolean;
}[] {
  const acc = new Map<
    string,
    {
      sessions: number;
      messages: number;
      tokens: number;
      cost: number | null;
      costEstimated: boolean;
    }
  >();
  for (const agent of include) {
    acc.set(agent, { sessions: 0, messages: 0, tokens: 0, cost: null, costEstimated: false });
  }
  for (const d of days) {
    for (const [agent, v] of Object.entries(d.byAgent ?? {})) {
      const prev = acc.get(agent) ?? {
        sessions: 0,
        messages: 0,
        tokens: 0,
        cost: null as number | null,
        costEstimated: false,
      };
      acc.set(agent, {
        sessions: prev.sessions + (v.sessions ?? 0),
        messages: prev.messages + (v.messages ?? 0),
        tokens: prev.tokens + (v.tokens ?? 0),
        cost: addCost(prev.cost, v.cost),
        costEstimated: prev.costEstimated || !!v.costEstimated,
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

/** A token breakdown with its headline attached. */
export interface UsageRow extends TokenUsage {
  readonly tokens: number;
  readonly cost: number | null;
}

const ZERO_USAGE: UsageRow = {
  tokens: 0,
  input: 0,
  output: 0,
  cacheCreate: 0,
  cacheRead: 0,
  total: 0,
  cost: null,
};

/**
 * Roll a window's days up into the table behind the Tokens card: the window
 * total, then a row per agent, each with its models.
 *
 * Returns `null` when no day in the window carried a breakdown — the caller
 * shows "no detail available" rather than a table of zeros, which would claim
 * the answer is "nothing" when it is really "nobody reported".
 *
 * The headline is summed from the per-day `tokens` the bridge already reported,
 * never recomputed here. One definition, one place: if this re-derived it, the
 * card and its detail view could drift apart.
 */
export function usageBreakdown(days: readonly ActivityDay[]): {
  total: UsageRow;
  agents: { agent: string; tokens: number; usage: UsageRow; models: readonly ModelRow[] }[];
} | null {
  const add = (a: UsageRow, b: TokenUsage, tokens: number, cost?: number | null): UsageRow => ({
    tokens: a.tokens + tokens,
    input: a.input + b.input,
    output: a.output + b.output,
    cacheCreate: a.cacheCreate + b.cacheCreate,
    cacheRead: a.cacheRead + b.cacheRead,
    total: a.total + b.total,
    cost: addCost(a.cost, cost ?? null),
  });

  let any = false;
  let total = ZERO_USAGE;
  // Models accumulate into a keyed map and are sorted ONCE at the end. Folding
  // them with mergeModels per day meant a fresh Map, a concat and a full sort
  // on every day x agent — ~365 sorts per mount over a year window, all but the
  // last discarded — and this runs in render on every period change.
  const byAgent = new Map<
    string,
    { tokens: number; usage: UsageRow; models: Map<string, ModelRow> }
  >();
  for (const d of days) {
    if (d.usage) {
      any = true;
      total = add(total, d.usage, d.tokens || 0, d.cost);
    }
    for (const [agent, v] of Object.entries(d.byAgent ?? {})) {
      if (!v.usage) continue;
      any = true;
      let acc = byAgent.get(agent);
      if (!acc) {
        acc = { tokens: 0, usage: ZERO_USAGE, models: new Map() };
        byAgent.set(agent, acc);
      }
      acc.tokens += v.tokens ?? 0;
      acc.usage = add(acc.usage, v.usage, v.tokens ?? 0, v.cost);
      for (const m of v.usage.models ?? []) {
        const prev = acc.models.get(m.model);
        acc.models.set(
          m.model,
          prev
            ? {
                ...prev,
                tokens: prev.tokens + m.tokens,
                input: prev.input + m.input,
                output: prev.output + m.output,
                cacheCreate: prev.cacheCreate + m.cacheCreate,
                cacheRead: prev.cacheRead + m.cacheRead,
                total: prev.total + m.total,
                cost: addCost(prev.cost, m.cost),
              }
            : // Stamped here, where the agent is still in hand. Callers flatten
              // these lists into one table, and by then the only thing telling
              // Codex's gpt-5.5 from opencode's is this field.
              { ...m, agent },
        );
      }
    }
  }
  if (!any) return null;
  return {
    total,
    agents: [...byAgent]
      .map(([agent, v]) => ({
        agent,
        tokens: v.tokens,
        usage: v.usage,
        models: [...v.models.values()].sort((x, y) => y.tokens - x.tokens),
      }))
      .sort((a, b) => b.tokens - a.tokens),
  };
}

/**
 * Sessions and messages per space, over a window.
 *
 * Sorted by sessions: the question this answers is "where does the work
 * happen", and a space with many short sessions is a more useful answer than
 * one long one. Threads with no repo arrive under "" and the caller labels
 * them — they're dropped from neither the rows nor the total, so the parts add
 * up to the headline.
 */
export function byRepoTotals(
  days: readonly ActivityDay[],
): { repo: string; sessions: number; messages: number }[] {
  const acc = new Map<string, { sessions: number; messages: number }>();
  for (const d of days) {
    for (const [repo, v] of Object.entries(d.byRepo ?? {})) {
      const prev = acc.get(repo) ?? { sessions: 0, messages: 0 };
      acc.set(repo, {
        sessions: prev.sessions + (v.sessions ?? 0),
        messages: prev.messages + (v.messages ?? 0),
      });
    }
  }
  return [...acc]
    .map(([repo, v]) => ({ repo, ...v }))
    .sort((a, b) => b.sessions - a.sessions || b.messages - a.messages);
}
