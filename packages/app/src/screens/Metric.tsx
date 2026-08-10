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
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import { fetchActivity } from "../services/bridge";
import {
  type ActivityDay,
  PERIOD_DAYS,
  PERIOD_LABEL,
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
import { MiniBarChart } from "../components/MiniBarChart";
import { ActivitySkeleton } from "../components/Skeleton";
import { PounceIcon } from "../ui/native/Icon";
import { AgentLogo, IS_DESKTOP } from "../ui";
import { agentLabel } from "../ui/tokens";
import { fmtCost, fmtCount, fmtDelta, fmtTokens } from "../ui/format";

const YEAR = 365;

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

/** A share as a percentage, never rounding a real quantity down to "0%". */
function pct(part: number, whole: number): string {
  if (whole <= 0 || part <= 0) return "0%";
  const p = (part / whole) * 100;
  return p < 1 ? "<1%" : `${Math.round(p)}%`;
}

/**
 * Anything carrying the four metrics: a day, a window total from `sumDays`, or
 * an agent row from `byAgentTotals`. They already share this shape, so one
 * accessor serves all three — this used to be four separate ternary ladders
 * (day, window total, previous total, agent row) that had to agree by hand,
 * and a page whose bars disagree with its own headline is a silent failure.
 */
type Countable = {
  readonly sessions: number;
  readonly messages: number;
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
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { theme } = useUnistyles();
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

  // A year is charted by month; shorter windows by day. Same rule as the
  // dashboard's chart, so the two never disagree about a period.
  const bars = useMemo(() => {
    if (period !== "year") return window.map((d) => ({ key: d.date, value: valueOf(d, key) }));
    const byMonth = new Map<string, number>();
    for (const d of window) {
      const k = d.date.slice(0, 7);
      byMonth.set(k, (byMonth.get(k) ?? 0) + valueOf(d, key));
    }
    return [...byMonth].map(([k, value]) => ({ key: k, value }));
  }, [period, window, key]);

  const agents = useMemo(() => byAgentTotals(window), [window]);
  // Both folds walk the whole window, and each is read by only two of the four
  // metrics — models/composition come from `usage`, the space rows from
  // `repos`. Gating them keeps a Sessions page from paying for a breakdown it
  // never renders.
  const repos = useMemo(
    () => (key === "sessions" || key === "messages" ? byRepoTotals(window) : null),
    [window, key],
  );
  const usage = useMemo(
    () => (key === "tokens" || key === "spend" ? usageBreakdown(window) : null),
    [window, key],
  );

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

  // Sorted and totalled once per (usage, key) rather than on every render —
  // onLayout alone guarantees at least one extra render per mount.
  const models = useMemo(() => {
    if (!usage) return [];
    const rows = usage.agents
      .flatMap((a) => a.models)
      .slice()
      .sort((x, y) => (key === "spend" ? (y.cost ?? 0) - (x.cost ?? 0) : y.tokens - x.tokens));
    const sum = rows.reduce((n, m) => n + (key === "spend" ? (m.cost ?? 0) : m.tokens), 0);
    return rows.map((m) => ({
      model: m,
      share: sum > 0 ? (key === "spend" ? (m.cost ?? 0) : m.tokens) / sum : 0,
    }));
  }, [usage, key]);

  const periodWord =
    period === "year" ? "in the last 12 months" : `in the last ${PERIOD_DAYS[period]} days`;

  return (
    <ScrollView
      style={s.root}
      contentContainerStyle={[
        s.content,
        { paddingTop: IS_DESKTOP ? 14 : insets.top + 8, paddingBottom: insets.bottom + 32 },
      ]}
    >
      <View style={s.header}>
        {/* Desktop opens this as a pane with its own tab chrome, so a back
            control there would be a second, competing way out. */}
        {!IS_DESKTOP ? (
          <Pressable
            onPress={() => router.back()}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Back"
            style={({ pressed }) => [s.back, pressed && s.pressed]}
          >
            <PounceIcon name="chevron-back" size={20} color={theme.colors.accent} />
          </Pressable>
        ) : null}
        <View style={s.shrink}>
          <Text style={s.title}>{METRIC_TITLE[key]}</Text>
          <Text style={s.subtitle}>{periodWord}</Text>
        </View>
      </View>

      {/* No period picker over a failed read: it would narrow numbers we never
          got, three ways. */}
      {q.isError ? null : (
        <View style={s.periods}>
          {(["week", "month", "year"] as const).map((p) => (
            <Pressable
              key={p}
              onPress={() => setPeriod(p)}
              style={({ pressed }) => [s.period, period === p && s.periodOn, pressed && s.pressed]}
            >
              <Text style={[s.periodLabel, period === p && s.periodLabelOn]}>
                {PERIOD_LABEL[p]}
              </Text>
            </Pressable>
          ))}
        </View>
      )}

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
            <Text style={s.heroValue}>{key === "spend" ? fmtCost(total) : fmtCount(total)}</Text>
            <View style={s.heroMeta}>
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
              style={s.chartCard}
              onLayout={(e: LayoutChangeEvent) => setChartWidth(e.nativeEvent.layout.width - 28)}
            >
              {chartWidth > 0 ? <MiniBarChart bars={bars} width={chartWidth} /> : null}
            </View>
            <Text style={s.sectionNote}>
              {activeDays} active {activeDays === 1 ? "day" : "days"}
              {activeDays > 0 ? ` · ${format(total / activeDays, key)} per active day` : ""}
              {busiest && valueOf(busiest, key) > 0
                ? ` · busiest ${busiest.date} at ${format(valueOf(busiest, key), key)}`
                : ""}
            </Text>
          </View>

          <MetricInsight metricKey={key} window={window} totals={now} usage={usage} />

          {/* What the total is MADE OF. Only tokens has this: it's the metric
              whose headline is most often misread, because most of it is
              usually re-sent context rather than anything newly written. */}
          {key === "tokens" && usage ? (
            <Section title="Composition">
              {(
                [
                  ["Fresh input", usage.total.input],
                  ["Output", usage.total.output],
                  ["Cache write", usage.total.cacheCreate],
                  ["Cache read", usage.total.cacheRead],
                ] as const
              ).map(([label, v]) => (
                <ShareRow
                  key={label}
                  label={label}
                  value={fmtCount(v)}
                  share={usage.total.total > 0 ? v / usage.total.total : 0}
                  // "<1%", never "0%": fresh input is a real 0.06% here, and
                  // rounding it to zero says it didn't happen.
                  sub={usage.total.total > 0 ? `${pct(v, usage.total.total)} of the total` : null}
                />
              ))}
            </Section>
          ) : null}

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
                const v = metricOfAgent(a, key);
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
                    sub={
                      key === "sessions" && a.sessions > 0 && a.messages > 0
                        ? `${fmtCount(Math.round(a.messages / a.sessions))} messages per session`
                        : key === "messages" && a.sessions > 0
                          ? `across ${fmtCount(a.sessions)} sessions`
                          : null
                    }
                  />
                );
              })
            ) : (
              <Text style={s.empty}>Nothing in this period.</Text>
            )}
          </Section>

          {/* Models only exist for the two money/token metrics, and only when
              ccusage could read them. */}
          {(key === "tokens" || key === "spend") && usage ? (
            <Section
              title="By model"
              note={
                key === "spend"
                  ? "Where the money actually went. A model can cost more than a bigger one — worth checking before assuming the largest number is the expensive one."
                  : null
              }
            >
              {models.length ? (
                models.map(({ model: m, share }) => (
                  <ShareRow
                    key={m.model}
                    label={m.model}
                    value={
                      key === "spend"
                        ? m.cost == null
                          ? "—"
                          : fmtCost(m.cost)
                        : fmtCount(m.tokens)
                    }
                    share={share}
                    sub={
                      key === "spend"
                        ? `${fmtTokens(m.tokens)} tokens`
                        : m.cost == null
                          ? null
                          : `${fmtCost(m.cost)} at list price`
                    }
                  />
                ))
              ) : (
                <Text style={s.empty}>No model detail reported.</Text>
              )}
            </Section>
          ) : null}

          {/* Spaces answer "where", which neither agent nor model can. Only for
              the two metrics the bridge can honestly attribute to a repo. */}
          {(key === "sessions" || key === "messages") && repos?.length ? (
            <Section title="By space">
              {repos.map((r) => {
                const v = key === "sessions" ? r.sessions : r.messages;
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

function metricOfAgent(
  a: { sessions: number; messages: number; tokens: number; cost: number | null },
  key: MetricKey,
): number {
  if (key === "tokens") return a.tokens;
  if (key === "spend") return a.cost ?? 0;
  if (key === "sessions") return a.sessions;
  return a.messages;
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
      const pct = Math.round((t.cacheRead / t.total) * 100);
      const fresh = t.input + t.output + t.cacheCreate;
      return `${pct}% of this — ${fmtCount(t.cacheRead)} tokens — was context re-read from cache rather than new input. Only ${fmtCount(fresh)} was fresh. Cache reads are billed far cheaper than new input, so a large share here is efficient, not wasteful.`;
    }
    if (metricKey === "spend") {
      if (!totals.cost) return null;
      const days = window.filter((d) => (d.cost ?? 0) > 0).length;
      return `This is what these tokens would have cost at public API rates${
        days ? `, spread over ${days} ${days === 1 ? "day" : "days"}` : ""
      }. If you're on a subscription, you paid a flat fee instead — so read this as the value delivered, not money spent.`;
    }
    const { sessions, messages } = totals;
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

const s = StyleSheet.create((theme) => ({
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
  chartCard: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
    padding: 14,
  },
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
