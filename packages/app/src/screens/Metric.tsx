/**
 * One metric, opened up — what's behind a number on the Activity dashboard.
 *
 * A page rather than a sheet because there are four things to say about each
 * figure (how it moved, who spent it, where, and on what), and a sheet can only
 * hold the first two before it becomes a scroll well.
 *
 * The rule for every section here: lead with the fact somebody would otherwise
 * miss, then show the evidence. A table nobody reads is worse than no table —
 * the dashboard already has the totals.
 */
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View, type LayoutChangeEvent } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useQuery } from "@tanstack/react-query";
import { useLocalSearchParams } from "expo-router";
import { fetchActivity } from "../services/bridge";
import {
  type ActivityDay,
  type UsageRow,
  addCost,
  PERIOD_DAYS,
  type Period,
  byAgentTotals,
  byRepoTotals,
  delta,
  periodSlice,
  sumDays,
  usageBreakdown,
  zeroFill,
} from "../services/activity";
import { useProjectNames } from "../state/db/hooks";
import { bucketByMonth } from "../components/usageSeries";
import { CHART_GUTTER, UsageChart } from "../components/UsageChart";
import { ActivitySkeleton } from "../components/Skeleton";
import { PeriodPicker } from "../components/PeriodPicker";
import { AgentLogo, IS_DESKTOP } from "../ui";
import { agentLabel } from "../ui/tokens";
import { fmtCost, fmtCount, fmtDayLabel, fmtDelta, fmtTokens } from "../ui/format";

const YEAR = 365;
const PERIODS: readonly Period[] = ["week", "month", "year"];

/** The metrics a tile can open, in one place: the type, the runtime validation
 *  of a route param, and the desktop tab strip's list all derive from this, so
 *  a fifth metric can't be added to one and forgotten in the others. */
export const METRIC_KEYS = ["tokens", "spend", "sessions", "messages"] as const;
export type MetricKey = (typeof METRIC_KEYS)[number];

export const METRIC_TITLE: Record<MetricKey, string> = {
  tokens: "Tokens",
  spend: "Estimated spend",
  sessions: "Sessions",
  messages: "Messages",
};

/**
 * A space's display name. Falls back to the id with its `repo:`/`ws:` prefix
 * stripped — the same treatment the desktop tab strip gives it, so a project
 * that hasn't synced its name yet still reads as a place rather than a key.
 */
function repoLabel(repo: string, names: Record<string, string>): string {
  return names[repo] ?? repo.replace(/^(repo:|ws:)/, "");
}

/**
 * A share as a percentage, never rounding away the thing it is describing.
 *
 * Both ends matter and for the same reason. Fresh input is a real 0.006% of the
 * tokens here, and "0%" says it didn't happen; cache reads are 99.993%, and
 * "100%" says nothing else did. A reader who sees 100% next to a non-zero
 * figure below it concludes one of the two is wrong.
 */
function pct(part: number, whole: number): string {
  if (whole <= 0 || part <= 0) return "0%";
  const p = (part / whole) * 100;
  if (p < 1) return "<1%";
  if (p > 99 && p < 100) return ">99%";
  return `${Math.round(p)}%`;
}

/**
 * Anything carrying the metrics: a day, a window total from `sumDays`, an agent
 * row from `byAgentTotals`, or a model row. They already share this shape, so
 * one accessor serves them all — this used to be four separate ternary ladders
 * (day, window total, previous total, agent row) that had to agree by hand,
 * and a page whose chart disagrees with its own headline is a silent failure.
 */
type Countable = {
  /** Absent on a model row, which is counted but never held a session. The two
   *  metrics that read these are the two a model row is never shown for. */
  readonly sessions?: number;
  readonly messages?: number;
  readonly tokens: number;
  readonly cost: number | null;
};

/** The value this page charts and sums. */
function valueOf(m: Countable, key: MetricKey): number {
  if (key === "tokens") return m.tokens || 0;
  if (key === "spend") return m.cost ?? 0;
  if (key === "sessions") return m.sessions || 0;
  return m.messages || 0;
}

function format(n: number, key: MetricKey): string {
  if (key === "tokens") return fmtTokens(n);
  if (key === "spend") return fmtCost(n);
  return fmtCount(n);
}

/**
 * The line under an agent's bar.
 *
 * Each metric has a different useful second fact, so this is a list of rules
 * rather than one template. Returns null when there is nothing true to say —
 * Cursor publishes neither tokens nor dollars, and "0% of cost · 0 tokens"
 * states as fact the very thing we could not read.
 */
function agentSub(
  a: { sessions: number; messages: number; tokens: number; cost: number | null },
  key: MetricKey,
  agentTotal: number,
): string | null {
  // The share PLUS the other metric — an agent can be 3% of the tokens and 40%
  // of the bill, and only seeing both at once makes that visible.
  if (key === "spend") {
    if (a.cost == null && !a.tokens) return null;
    return `${pct(a.cost ?? 0, agentTotal)} of cost · ${fmtTokens(a.tokens)} tokens`;
  }
  if (key === "tokens") {
    if (a.cost == null && !a.tokens) return null;
    return `${pct(a.tokens, agentTotal)} of tokens${a.cost == null ? "" : ` · ${fmtCost(a.cost)}`}`;
  }
  if (key === "sessions") {
    if (!a.sessions || !a.messages) return null;
    return `${fmtCount(Math.round(a.messages / a.sessions))} messages per session`;
  }
  return a.sessions > 0 ? `across ${fmtCount(a.sessions)} sessions` : null;
}

/** A labelled row with a bar showing its share — the shape every breakdown
 *  below uses, so four different questions read the same way. */
function ShareRow({
  label,
  icon,
  value,
  sub,
  share,
}: {
  label: string;
  icon?: React.ReactNode;
  value: string;
  sub?: string | null;
  share: number;
}) {
  return (
    <View style={s.row}>
      <View style={s.rowHead}>
        {icon}
        <Text numberOfLines={1} style={s.rowLabel}>
          {label}
        </Text>
        <Text style={s.rowValue}>{value}</Text>
      </View>
      <View style={s.track}>
        <View style={[s.fill, { width: `${Math.max(1, Math.round(share * 100))}%` }]} />
      </View>
      {sub ? <Text style={s.rowSub}>{sub}</Text> : null}
    </View>
  );
}

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note?: string | null;
  children: React.ReactNode;
}) {
  return (
    <View style={s.section}>
      <Text style={s.sectionTitle}>{title}</Text>
      {note ? <Text style={s.sectionNote}>{note}</Text> : null}
      <View style={s.card}>{children}</View>
    </View>
  );
}

export default function MetricScreen() {
  const params = useLocalSearchParams<{ key?: string; period?: string }>();
  const projectNames = useProjectNames();
  const key = METRIC_KEYS.includes(params.key as MetricKey) ? (params.key as MetricKey) : "tokens";
  const [period, setPeriod] = useState<Period>(
    (["week", "month", "year"] as const).includes(params.period as Period)
      ? (params.period as Period)
      : "month",
  );
  const [chartWidth, setChartWidth] = useState(0);

  // The SAME query key the dashboard uses, so opening this page reads the
  // series already in cache instead of re-scanning every transcript.
  const q = useQuery({
    queryKey: ["activity", YEAR],
    queryFn: () => fetchActivity(YEAR),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const year = useMemo(() => zeroFill(q.data?.days ?? [], YEAR), [q.data]);
  const { window, previous } = useMemo(() => periodSlice(year, period), [year, period]);
  const now = useMemo(() => sumDays(window), [window]);
  const before = useMemo(() => sumDays(previous), [previous]);

  const total = valueOf(now, key);
  const prior = valueOf(before, key);

  /** The two metrics ccusage can break down — they get the usage treatment
   *  (layered per-agent chart, token strip, model/day breakdown). Sessions and
   *  messages have none of that behind them. */
  const isUsage = key === "tokens" || key === "spend";

  /** A year is charted at MONTH resolution — 365 points is a fine curve and a
   *  hopeless thing to read one bucket off. The fold keeps the per-agent split,
   *  so the year chart is the same agent chart as every other period. */
  const chartDays = useMemo(
    () => (period === "year" ? bucketByMonth(window) : window),
    [window, period],
  );

  const agents = useMemo(() => byAgentTotals(window), [window]);
  // Both folds walk the whole window, and each is read by only two of the four
  // metrics — models/composition come from `usage`, the space rows from
  // `repos`. Gating them keeps a Sessions page from paying for a breakdown it
  // never renders.
  const repos = useMemo(() => (isUsage ? null : byRepoTotals(window)), [window, isUsage]);
  const usage = useMemo(() => (isUsage ? usageBreakdown(window) : null), [window, isUsage]);

  /** Days in the window that saw any of this metric — the denominator for
   *  "per active day", which is a fairer average than dividing by 30. */
  const activeDays = useMemo(() => window.filter((d) => valueOf(d, key) > 0).length, [window, key]);
  const busiest = useMemo(
    () =>
      window.reduce<ActivityDay | null>(
        (best, d) => (!best || valueOf(d, key) > valueOf(best, key) ? d : best),
        null,
      ),
    [window, key],
  );

  const agentTotal = agents.reduce((n, a) => n + valueOf(a, key), 0);
  /** A space row's figure for this metric — spaces only carry these two. */
  const repoValue = (r: { sessions: number; messages: number }) =>
    key === "sessions" ? r.sessions : r.messages;
  const repoTotal = (repos ?? []).reduce((n, r) => n + repoValue(r), 0);

  /**
   * Agents with something to show for THIS metric, biggest first.
   *
   * Ranked by the metric on screen rather than by `byAgentTotals`' token order:
   * the day table only has room for the first two columns, and on the spend
   * page those should be the two that cost the most. Codex outspends opencode
   * while using a fraction of its tokens, so the token ranking picks the wrong
   * pair here.
   */
  const chartAgents = useMemo(
    () =>
      agents
        .filter((a) => valueOf(a, key) > 0)
        .sort((x, y) => valueOf(y, key) - valueOf(x, key))
        .map((a) => a.agent),
    [agents, key],
  );

  // The window's actual extent, which is what a reader checks a total against —
  // "in the last 30 days" doesn't say WHICH 30.
  const range =
    window.length > 1
      ? `${fmtDayLabel(window[0].date)} to ${fmtDayLabel(window[window.length - 1].date)}`
      : period === "year"
        ? "in the last 12 months"
        : `in the last ${PERIOD_DAYS[period]} days`;

  return (
    <ScrollView
      style={s.root}
      // iOS ties the large title to this scroll view, and insets it for the bar
      // — so no top padding of our own on mobile. See ScreenRoot for the rule
      // about it having to be the screen's first child (it is: this IS the root).
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={[s.content, s.contentPad]}
    >
      {/* The title belongs to the header the STACK draws, and only this screen
          knows which metric it is. A no-op on desktop, where the router is
          shimmed and the pane has its own tab chrome. */}
      <View style={s.header}>
        <View style={s.shrink}>
          {/* Desktop has no stack header, so it still draws its own title. On
              mobile that would be the same word twice, one above the other. */}
          {IS_DESKTOP ? <Text style={s.title}>{METRIC_TITLE[key]}</Text> : null}
          <Text style={s.subtitle}>{range}</Text>
        </View>
      </View>

      {/* No period picker over a failed read: it would narrow numbers we never
          got, three ways. */}
      {q.isError ? null : <PeriodPicker value={period} onChange={setPeriod} periods={PERIODS} />}

      {q.isPending ? (
        <ActivitySkeleton />
      ) : q.isError ? (
        // `fetchActivity` THROWS when every paired host fails — deliberately, so
        // callers can say "couldn't read" instead of asserting a zero. Without
        // this branch `zeroFill` manufactured a clean year and the page rendered
        // a confident 0 hero, "no earlier month to compare against" and "Nothing
        // in this period" — for someone with months of history whose Mac is
        // asleep. Same words the dashboard uses for the same failure.
        <View style={s.errorBox}>
          <Text style={s.errorTitle}>Couldn&apos;t read your history</Text>
          <Text style={s.errorBody}>
            The machine didn&apos;t answer in time. If it&apos;s been a while since you opened
            Pounce there, it may still be reading through your transcripts.
          </Text>
          <Pressable
            onPress={() => void q.refetch()}
            style={({ pressed }) => [s.retryBtn, pressed && s.pressed]}
          >
            <Text style={s.retryLabel}>Try again</Text>
          </Pressable>
        </View>
      ) : (
        <>
          <View style={s.hero}>
            <Text style={s.heroValue}>
              {key === "spend" ? `${fmtCost(total)}*` : fmtCount(total)}
            </Text>
            <View style={s.heroMeta}>
              {/* The asterisk's other half. These are list prices, and on a
                  subscription seat the marginal cost of the same tokens is
                  zero — the shortest true sentence about the number above. */}
              {key === "spend" ? (
                <Text style={s.heroDelta}>* if billed at full API rate</Text>
              ) : null}
              {fmtDelta(delta(total, prior)) ? (
                <Text style={s.heroDelta}>
                  {fmtDelta(delta(total, prior))} vs the previous {period}
                </Text>
              ) : (
                <Text style={s.heroDelta}>no earlier {period} to compare against</Text>
              )}
            </View>
          </View>

          {/* Trend first: "how did this move" is the question a number on a
              card can't answer, and it's why this page exists. */}
          <View style={s.section}>
            <Text style={s.sectionTitle}>{period === "year" ? "By month" : "By day"}</Text>
            <View
              style={[s.card, s.chartCard]}
              onLayout={(e: LayoutChangeEvent) => setChartWidth(e.nativeEvent.layout.width - 28)}
            >
              {chartWidth <= 0 ? null : (
                // Per agent for every metric, because "who did this" and "when"
                // is one question — sessions and messages are reported per agent
                // exactly as spend and tokens are.
                <UsageChart
                  days={chartDays}
                  agents={chartAgents}
                  metric={key === "spend" ? "cost" : key}
                  granularity={period === "year" ? "month" : "day"}
                  width={chartWidth - CHART_GUTTER}
                />
              )}
            </View>
            <Text style={s.sectionNote}>
              {activeDays} active {activeDays === 1 ? "day" : "days"}
              {activeDays > 0 ? ` · ${format(total / activeDays, key)} per active day` : ""}
              {busiest && valueOf(busiest, key) > 0
                ? ` · busiest ${fmtDayLabel(busiest.date)} at ${format(valueOf(busiest, key), key)}`
                : ""}
            </Text>
          </View>

          {/* What the tokens WERE, for both metrics: on the spend page it is
              what the money bought, and on the tokens page it is the thing
              itself. Most of the total is usually re-sent context rather than
              anything newly written, which the headline alone never says. */}
          {isUsage && usage ? <TokenStrip usage={usage.total} activeDays={activeDays} /> : null}

          <MetricInsight metricKey={key} window={window} totals={now} usage={usage} />

          <Section
            title="By agent"
            note={
              key === "spend"
                ? "Priced at public list rates. On a subscription seat you have already paid a flat fee, so this is the value you got — not a bill."
                : null
            }
          >
            {agents.length ? (
              agents.map((a) => {
                const v = valueOf(a, key);
                return (
                  <ShareRow
                    key={a.agent}
                    label={agentLabel(a.agent)}
                    icon={<AgentLogo agent={a.agent} size={14} />}
                    // "—", not "$0.00", when nothing could price this agent.
                    // Cursor reports no dollars at all; rendering that as zero
                    // claims it was free, which is a different (and false)
                    // statement from "not knowable".
                    value={key === "spend" ? (a.cost == null ? "—" : fmtCost(a.cost)) : fmtCount(v)}
                    share={agentTotal > 0 ? v / agentTotal : 0}
                    // Only when there's a real ratio to state. opencode and
                    // Cursor keep no dated message counts, so "0 messages per
                    // session" would assert something false about an agent that
                    // simply doesn't report them.
                    sub={agentSub(a, key, agentTotal)}
                  />
                );
              })
            ) : (
              <Text style={s.empty}>Nothing in this period.</Text>
            )}
          </Section>

          {/* Models and days only exist for the two money/token metrics, and
              only when ccusage could read them. */}
          {isUsage && usage ? (
            <Breakdown metricKey={key} usage={usage} window={window} agents={chartAgents} />
          ) : null}

          {/* Spaces answer "where", which neither agent nor model can. Only for
              the two metrics the bridge can honestly attribute to a repo. */}
          {(key === "sessions" || key === "messages") && repos?.length ? (
            <Section title="By space">
              {repos.map((r) => {
                const v = repoValue(r);
                if (!v) return null;
                return (
                  <ShareRow
                    key={r.repo || "(none)"}
                    label={r.repo ? repoLabel(r.repo, projectNames) : "No project"}
                    value={fmtCount(v)}
                    share={repoTotal > 0 ? v / repoTotal : 0}
                    sub={
                      key === "messages" && r.sessions > 0 && r.messages > 0
                        ? `${fmtCount(Math.round(r.messages / r.sessions))} per session`
                        : null
                    }
                  />
                );
              })}
            </Section>
          ) : null}
        </>
      )}
    </ScrollView>
  );
}

/**
 * What the window's tokens actually were, in four figures.
 *
 * These sit under the chart on BOTH usage pages because they answer the same
 * question from either side: on Tokens they break the headline down, and on
 * Spend they say what the money bought. The split that matters is cached versus
 * fresh — cache reads run from ~78% to ~98% of a total, so a reader who assumes
 * the headline is all new input is badly wrong about what it means.
 */
function TokenStrip({ usage, activeDays }: { usage: UsageRow; activeDays: number }) {
  const observed = usage.input + usage.cacheRead;
  const tiles: { label: string; value: string; detail: string }[] = [
    {
      label: "Processed tokens",
      value: fmtTokens(usage.total),
      detail: activeDays > 0 ? `${fmtTokens(usage.total / activeDays)} per active day` : "—",
    },
    {
      label: "Cached input",
      value: fmtTokens(usage.cacheRead),
      detail: `${pct(usage.cacheRead, observed)} of input read`,
    },
    {
      label: "Fresh input",
      value: fmtTokens(usage.input),
      detail: `${fmtTokens(usage.cacheCreate)} written to cache`,
    },
    {
      label: "Output",
      value: fmtTokens(usage.output),
      detail: `${pct(usage.output, usage.total)} of the total`,
    },
  ];
  return (
    <View style={[s.card, s.strip]}>
      {tiles.map((t) => (
        <View key={t.label} style={s.tile}>
          <Text style={s.tileLabel}>{t.label}</Text>
          <Text style={s.tileValue}>{t.value}</Text>
          <Text style={s.tileDetail}>{t.detail}</Text>
        </View>
      ))}
    </View>
  );
}

/**
 * One numeric column of the by-day table.
 *
 * `agents` is what the column sums, which is why "Other" needs no special case
 * downstream: a named agent is simply a group of one.
 */
interface DayColumn {
  readonly key: string;
  readonly label: string;
  readonly agents: readonly string[];
}

/**
 * The same window, cut two ways: by model and by day.
 *
 * A toggle rather than two sections because they answer the same question —
 * "where did this go" — and stacking both makes the page a scroll well. Model
 * leads: it's the cut that most often surprises, since a smaller model can
 * outspend a bigger one.
 */
function Breakdown({
  metricKey,
  usage,
  window,
  agents,
}: {
  metricKey: MetricKey;
  usage: ReturnType<typeof usageBreakdown>;
  window: readonly ActivityDay[];
  agents: readonly string[];
}) {
  const [cut, setCut] = useState<"model" | "day">("model");
  const spend = metricKey === "spend";

  /**
   * Every model used in the window, biggest first.
   *
   * A row is (agent, model), never model alone — `usage.agents` holds a model
   * list per agent and the same model name appears under more than one of them.
   * Measured on a year of real history: `gpt-5.4` and `gpt-5.5` were each run by
   * both Codex and opencode, so flattening on the name collided two real rows
   * onto one React key.
   */
  const models = useMemo(() => {
    const rows = (usage?.agents ?? [])
      .flatMap((a) => a.models)
      .sort((x, y) => valueOf(y, metricKey) - valueOf(x, metricKey));
    const sum = rows.reduce((n, m) => n + valueOf(m, metricKey), 0);
    return rows.map((m) => ({ model: m, share: sum > 0 ? valueOf(m, metricKey) / sum : 0 }));
  }, [usage, metricKey]);
  /**
   * Four columns is what a phone holds: Day, two more, and the total.
   *
   * With more contributors than fit, the second column becomes "Other" rather
   * than the third-largest agent. Naming two and silently dropping the rest
   * left rows whose visible figures didn't add up to the Total beside them,
   * which reads as an arithmetic bug rather than as an omission.
   */
  const columns: DayColumn[] =
    agents.length <= 2
      ? agents.map((agent) => ({ key: agent, label: agentLabel(agent), agents: [agent] }))
      : [
          { key: agents[0], label: agentLabel(agents[0]), agents: [agents[0]] },
          // Everything the named column doesn't carry, so a row adds up to the
          // Total beside it.
          { key: "other", label: "Other", agents: agents.slice(1) },
        ];
  // Newest first, and only the days that saw anything — a table of empty rows
  // is scrolling with nothing at the end of it.
  const days = useMemo(
    () => window.filter((d) => valueOf(d, metricKey) > 0).reverse(),
    [window, metricKey],
  );

  return (
    <View style={s.section}>
      <View style={s.breakdownHead}>
        <Text style={s.sectionTitle}>Breakdown</Text>
        <View style={s.segments}>
          {(["model", "day"] as const).map((c) => (
            <Pressable
              key={c}
              onPress={() => setCut(c)}
              style={({ pressed }) => [s.segment, cut === c && s.segmentOn, pressed && s.pressed]}
            >
              <Text style={[s.segmentLabel, cut === c && s.segmentLabelOn]}>
                {c === "model" ? "Model" : "Day"}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View style={s.card}>
        {cut === "model" ? (
          models.length ? (
            models.map(({ model: m, share }) => (
              <ShareRow
                key={`${m.agent}:${m.model}`}
                label={m.model}
                // The agent that ran it. Two agents offer the same model, so
                // without this the rows are indistinguishable — named in the sub
                // line as well as marked, since a 14pt logo is not a label.
                icon={<AgentLogo agent={m.agent} size={14} />}
                // "—", not "$0.00": a model nothing could price was not free.
                value={spend ? (m.cost == null ? "—" : fmtCost(m.cost)) : fmtCount(m.tokens)}
                share={share}
                sub={
                  spend
                    ? `via ${agentLabel(m.agent)} · ${pct(share, 1)} of cost · ${fmtTokens(m.tokens)} tokens`
                    : `via ${agentLabel(m.agent)}${
                        m.cost == null ? "" : ` · ${fmtCost(m.cost)} at list price`
                      }`
                }
              />
            ))
          ) : (
            <Text style={s.empty}>No model detail reported.</Text>
          )
        ) : days.length ? (
          <>
            <View style={s.tr}>
              <Text style={[s.th, s.colDay]}>Day</Text>
              {columns.map((c) => (
                <Text key={c.key} style={[s.th, s.colNum]} numberOfLines={1}>
                  {c.label}
                </Text>
              ))}
              <Text style={[s.th, s.colNum]}>Total</Text>
            </View>
            {days.map((d) => (
              <View key={d.date} style={s.tr}>
                <Text style={[s.td, s.colDay]}>{fmtDayLabel(d.date)}</Text>
                {columns.map((c) => {
                  // One path for both kinds of column: a named agent is just a
                  // group of one, so "Other" needs no special case.
                  const v = c.agents.reduce<number | null>(
                    (n, a) => addCost(n, spend ? d.byAgent?.[a]?.cost : d.byAgent?.[a]?.tokens),
                    null,
                  );
                  return (
                    <Text key={c.key} style={[s.td, s.colNum, s.tdMuted]}>
                      {v == null ? "—" : spend ? fmtCost(v) : fmtTokens(v)}
                    </Text>
                  );
                })}
                <Text style={[s.td, s.colNum]}>
                  {spend ? fmtCost(d.cost ?? 0) : fmtTokens(d.tokens)}
                </Text>
              </View>
            ))}
          </>
        ) : (
          <Text style={s.empty}>Nothing in this period.</Text>
        )}
      </View>
    </View>
  );
}

/**
 * The one sentence worth reading on this page.
 *
 * Each metric has a fact that the headline hides, and it is different per
 * metric — so this is a switch, not a template. Nothing here is shown unless
 * the data actually supports it.
 */
function MetricInsight({
  metricKey,
  window,
  totals,
  usage,
}: {
  metricKey: MetricKey;
  window: readonly ActivityDay[];
  /** The window's totals, already summed by the parent. Passed in rather than
   *  re-reduced here — two definitions of "messages in this window" can drift,
   *  and this sentence exists to explain the headline above it. */
  totals: Countable;
  usage: ReturnType<typeof usageBreakdown>;
}) {
  const body = useMemo(() => {
    if (metricKey === "tokens") {
      if (!usage?.total.total) return null;
      const t = usage.total;
      const fresh = t.input + t.output + t.cacheCreate;
      return `${pct(t.cacheRead, t.total)} of this — ${fmtCount(t.cacheRead)} tokens — was context re-read from cache rather than new input. Only ${fmtCount(fresh)} was fresh. Cache reads are billed far cheaper than new input, so a large share here is efficient, not wasteful.`;
    }
    if (metricKey === "spend") {
      if (!totals.cost) return null;
      const days = window.filter((d) => (d.cost ?? 0) > 0).length;
      return `This is what these tokens would have cost at public API rates${
        days ? `, spread over ${days} ${days === 1 ? "day" : "days"}` : ""
      }. If you're on a subscription, you paid a flat fee instead — so read this as the value delivered, not money spent.`;
    }
    // Both absent on a shape that never held sessions; the guard covers it.
    const { sessions = 0, messages = 0 } = totals;
    if (!sessions) return null;
    const per = Math.round(messages / sessions);
    if (metricKey === "sessions") {
      return `${fmtCount(sessions)} sessions carried ${fmtCount(messages)} messages — about ${fmtCount(per)} per session. A high number means long iterative work; a low one means many short one-shot asks.`;
    }
    return `About ${fmtCount(per)} messages per session across ${fmtCount(sessions)} sessions. Sessions counted here are threads started in this window, so a long-running thread contributes messages without adding a session.`;
  }, [metricKey, window, totals, usage]);

  if (!body) return null;
  return (
    <View style={s.insight}>
      <Text style={s.insightText}>{body}</Text>
    </View>
  );
}

const s = StyleSheet.create((theme, rt) => ({
  /** Safe-area padding in the sheet — applied natively, no re-render. */
  contentPad: { paddingTop: IS_DESKTOP ? 14 : 0, paddingBottom: rt.insets.bottom + 32 },
  root: { flex: 1, backgroundColor: theme.colors.bg },
  content: { paddingHorizontal: 16, gap: 14 },
  header: { flexDirection: "row", alignItems: "center", gap: 6 },
  back: { marginLeft: -6, padding: 2 },
  shrink: { flexShrink: 1 },
  title: { fontSize: 24, fontWeight: "700", color: theme.colors.fg },
  subtitle: { fontSize: 12, color: theme.colors.fgFaint },
  pressed: { opacity: 0.7 },
  periods: { flexDirection: "row", gap: 2, alignSelf: "flex-start" },
  period: { borderRadius: 8, paddingHorizontal: 14, paddingVertical: 7 },
  periodOn: { backgroundColor: theme.colors.accent },
  periodLabel: { fontSize: 13, fontWeight: "600", color: theme.colors.fgMuted },
  periodLabelOn: { color: "#fff" },
  hero: { gap: 2 },
  heroValue: {
    fontFamily: "JetBrainsMono",
    fontSize: 34,
    fontWeight: "700",
    color: theme.colors.accent,
  },
  heroMeta: { flexDirection: "row", alignItems: "center", gap: 6 },
  heroDelta: { fontSize: 12, color: theme.colors.fgFaint },
  section: { gap: 8 },
  sectionTitle: {
    fontSize: 11,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    color: theme.colors.fgFaint,
  },
  sectionNote: { fontSize: 11.5, lineHeight: 17, color: theme.colors.fgFaint },
  card: {
    gap: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
    padding: 14,
  },
  /** `card` without its row gap — one child, which sets its own spacing. */
  chartCard: { gap: 0 },
  // The takeaway, styled as a remark rather than a card: it's prose, and boxing
  // it like the data would give it equal weight to the data.
  insight: {
    borderLeftWidth: 2,
    borderLeftColor: theme.colors.accent,
    paddingLeft: 10,
    paddingVertical: 2,
  },
  insightText: { fontSize: 12.5, lineHeight: 19, color: theme.colors.fgMuted },
  row: { gap: 5 },
  rowHead: { flexDirection: "row", alignItems: "center", gap: 7 },
  rowLabel: { flex: 1, fontSize: 13, color: theme.colors.fg },
  rowValue: { fontFamily: "JetBrainsMono", fontSize: 13, color: theme.colors.fg },
  rowSub: { fontSize: 11, color: theme.colors.fgFaint },
  track: { height: 4, borderRadius: 999, backgroundColor: theme.colors.border, overflow: "hidden" },
  fill: { height: 4, borderRadius: 999, backgroundColor: theme.colors.accent },
  empty: { fontSize: 12, color: theme.colors.fgFaint },
  // Four figures in a hairline grid. Deliberately not four cards: they are one
  // reading of one total, and boxing each would make them four findings.
  /** `card` laid out as a grid, and unpadded — each tile pads itself. */
  strip: { flexDirection: "row", flexWrap: "wrap", gap: 0, padding: 0, overflow: "hidden" },
  tile: { flexBasis: "50%", flexGrow: 1, gap: 1, padding: 12 },
  tileLabel: { fontSize: 11, color: theme.colors.fgFaint },
  tileValue: { fontFamily: "JetBrainsMono", fontSize: 17, color: theme.colors.fg },
  tileDetail: { fontSize: 10.5, color: theme.colors.fgFaint },
  breakdownHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  segments: { flexDirection: "row", gap: 2 },
  segment: { borderRadius: 7, paddingHorizontal: 10, paddingVertical: 4 },
  segmentOn: { backgroundColor: theme.colors.surfaceAlt },
  segmentLabel: { fontSize: 11.5, fontWeight: "600", color: theme.colors.fgFaint },
  segmentLabelOn: { color: theme.colors.fg },
  tr: { flexDirection: "row", alignItems: "center", gap: 8 },
  th: {
    fontSize: 10.5,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.4,
    color: theme.colors.fgFaint,
  },
  td: { fontFamily: "JetBrainsMono", fontSize: 12, color: theme.colors.fg },
  tdMuted: { color: theme.colors.fgMuted },
  colDay: { flex: 1, textAlign: "left" },
  colNum: { width: 72, textAlign: "right" },
  errorBox: { alignItems: "center", gap: 8, paddingHorizontal: 24, paddingVertical: 48 },
  errorTitle: { textAlign: "center", fontSize: 15, fontWeight: "600", color: theme.colors.fg },
  errorBody: {
    textAlign: "center",
    fontSize: 13,
    lineHeight: 18,
    color: theme.colors.fgMuted,
  },
  retryBtn: {
    marginTop: 4,
    borderRadius: 999,
    backgroundColor: theme.colors.surfaceAlt,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  retryLabel: { fontSize: 13, fontWeight: "600", color: theme.colors.accent },
}));
