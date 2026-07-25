import { useCallback, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  View,
  type LayoutChangeEvent,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery } from "@tanstack/react-query";
import { PounceIcon } from "../ui/native/Icon";
import { AgentLogo, IS_DESKTOP } from "../ui";
import { agentLabel } from "../ui/tokens";
import { fmtCost, fmtCount, fmtDayLabel, fmtDelta, fmtTokens } from "../ui/format";
import { fetchActivity, fetchQuota } from "../services/bridge";
import {
  type ActivityDay,
  PERIOD_DAYS,
  type Period,
  byAgentTotals,
  delta,
  partialAgents,
  periodSlice,
  quantize,
  streaks,
  sumDays,
  zeroFill,
} from "../services/activity";
import { ContributionGraph } from "../components/ContributionGraph";
import { QuotaCard } from "../components/QuotaCard";
import { MiniBarChart } from "../components/MiniBarChart";
import { StatTile } from "../components/StatTile";
import {
  DashboardShareCard,
  SHARE_CARD_HEIGHT,
  SHARE_CARD_WIDTH,
} from "../components/DashboardShareCard";
import { captureAvailable, shareDashboard } from "../services/share";

const YEAR = 365;
const PERIODS: Period[] = ["week", "month", "year"];
const PERIOD_LABEL: Record<Period, string> = { week: "Week", month: "Month", year: "Year" };

/**
 * The user's coding activity across every paired machine: a year-long heatmap,
 * headline stats for a chosen period, streaks, a trend chart, and a per-agent
 * split — shareable as an image.
 *
 * Everything here derives from ONE fetch of the merged daily series; the
 * arithmetic lives in services/activity.ts so it's unit-tested rather than
 * inlined in render.
 */
export default function DashboardScreen() {
  const insets = useSafeAreaInsets();
  const { theme } = useUnistyles();
  const [period, setPeriod] = useState<Period>("month");
  const [selected, setSelected] = useState<string | null>(null);
  const [chartWidth, setChartWidth] = useState(0);
  const [sharing, setSharing] = useState(false);
  const shareRef = useRef<View>(null);

  const q = useQuery({
    queryKey: ["activity", YEAR],
    queryFn: () => fetchActivity(YEAR),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  // Plan quota is a separate, much cheaper read than the year series, and it
  // matters most when it's near a limit — so it refreshes on its own cadence.
  const quotaQ = useQuery({
    queryKey: ["quota"],
    queryFn: fetchQuota,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  // One zero-filled year drives every view below, so the heatmap, the stats and
  // the streaks can never disagree about a day.
  const year = useMemo(() => zeroFill(q.data?.days ?? [], YEAR), [q.data]);
  const heat = useMemo(() => quantize(year), [year]);
  const { window, previous } = useMemo(() => periodSlice(year, period), [year, period]);
  const now = useMemo(() => sumDays(window), [window]);
  const before = useMemo(() => sumDays(previous), [previous]);
  const run = useMemo(() => streaks(year), [year]);
  const agents = useMemo(() => byAgentTotals(window), [window]);
  const partial = useMemo(() => partialAgents(q.data?.coverage ?? {}), [q.data]);
  const costComplete = q.data?.totals.costComplete !== false;

  // Trend bars: a day each for week/month, a month each for year (365 bars
  // would be 1px wide and unreadable).
  const bars = useMemo(() => {
    if (period !== "year") {
      return window.map((d) => ({ key: d.date, value: d.messages, label: fmtDayLabel(d.date) }));
    }
    const byMonth = new Map<string, number>();
    for (const d of year) {
      const k = d.date.slice(0, 7);
      byMonth.set(k, (byMonth.get(k) ?? 0) + d.messages);
    }
    return [...byMonth].map(([k, value]) => ({ key: k, value }));
  }, [period, window, year]);

  const detail = useMemo<ActivityDay | null>(
    () => (selected ? (year.find((d) => d.date === selected) ?? null) : null),
    [selected, year],
  );

  const onShare = useCallback(async () => {
    setSharing(true);
    try {
      // Let the offscreen card mount before capturing it.
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      await shareDashboard(shareRef);
    } finally {
      setSharing(false);
    }
  }, []);

  const canShare = !IS_DESKTOP && captureAvailable();
  const empty = !q.isLoading && now.messages === 0 && run.longest === 0;

  return (
    <View style={s.root}>
      <ScrollView
        contentContainerStyle={[
          s.content,
          { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 32 },
        ]}
        refreshControl={
          <RefreshControl
            refreshing={q.isFetching && !q.isLoading}
            onRefresh={() => q.refetch()}
            tintColor={theme.colors.fgMuted}
          />
        }
      >
        <View style={s.headerRow}>
          <View style={s.shrink}>
            <Text style={s.title}>Activity</Text>
            <Text style={s.subtitle}>
              {q.isLoading ? "Reading your history…" : `${fmtCount(run.longest)}-day best streak`}
            </Text>
          </View>
          {canShare ? (
            <Pressable
              onPress={onShare}
              disabled={sharing || q.isLoading}
              hitSlop={8}
              style={({ pressed }) => [s.shareBtn, pressed && s.pressed]}
            >
              {sharing ? (
                <ActivityIndicator size="small" color={theme.colors.accent} />
              ) : (
                <PounceIcon name="share-outline" size={16} color={theme.colors.accent} />
              )}
              <Text style={s.shareLabel}>Share</Text>
            </Pressable>
          ) : null}
        </View>

        {/* Period selector — drives the stat tiles and the trend chart only;
          the heatmap always shows the full year. */}
        <View style={s.segment}>
          {PERIODS.map((p) => (
            <Pressable
              key={p}
              onPress={() => setPeriod(p)}
              style={[s.segmentItem, p === period && s.segmentItemOn]}
            >
              <Text style={[s.segmentLabel, p === period && s.segmentLabelOn]}>
                {PERIOD_LABEL[p]}
              </Text>
            </Pressable>
          ))}
        </View>

        {q.isLoading ? (
          <View style={s.loading}>
            <ActivityIndicator color={theme.colors.fgMuted} />
          </View>
        ) : empty ? (
          <View style={s.emptyWrap}>
            <Text style={s.emptyEmoji}>📊</Text>
            <Text style={s.emptyTitle}>No activity yet</Text>
            <Text style={s.emptyBody}>
              Run a few sessions from a paired machine and your history shows up here.
            </Text>
          </View>
        ) : (
          <>
            {/* Tokens lead, not dollars: token counts are the agents' own
              numbers and always exist, whereas a dollar figure only appears
              for turns an agent actually priced (see the caveat below). */}
            <View style={s.tiles}>
              <StatTile
                label="Tokens"
                value={fmtTokens(now.tokens)}
                delta={fmtDelta(delta(now.tokens, before.tokens))}
                icon="sparkles"
                hero
              />
              <StatTile
                label="Reported spend"
                value={now.cost == null ? "—" : `${costComplete ? "" : "~"}${fmtCost(now.cost)}`}
                delta={fmtDelta(delta(now.cost, before.cost))}
                hint={now.cost == null ? "not reported" : costComplete ? null : "partial"}
                icon="card-outline"
                inverse
              />
            </View>
            <View style={s.tiles}>
              <StatTile
                label="Sessions"
                value={fmtCount(now.sessions)}
                delta={fmtDelta(delta(now.sessions, before.sessions))}
                icon="chatbubbles-outline"
              />
              <StatTile
                label="Messages"
                value={fmtCount(now.messages)}
                delta={fmtDelta(delta(now.messages, before.messages))}
                icon="git-commit-outline"
              />
            </View>

            <QuotaCard quotas={quotaQ.data ?? []} />

            <View style={s.streakRow}>
              <View style={s.streakItem}>
                <Text style={s.streakValue}>{run.current}</Text>
                <Text style={s.streakLabel}>day streak</Text>
              </View>
              <View style={s.streakDivider} />
              <View style={s.streakItem}>
                <Text style={s.streakValue}>{run.longest}</Text>
                <Text style={s.streakLabel}>longest</Text>
              </View>
              <View style={s.streakDivider} />
              <View style={s.streakItem}>
                <Text style={s.streakValue}>{year.filter((d) => d.messages > 0).length}</Text>
                <Text style={s.streakLabel}>active days</Text>
              </View>
            </View>

            <View style={s.card}>
              <Text style={s.cardTitle}>Last 12 months</Text>
              <ContributionGraph days={heat} selected={selected} onSelectDay={setSelected} />
              <Text numberOfLines={1} style={s.detailLine}>
                {detail
                  ? `${fmtDayLabel(detail.date)} — ${fmtCount(detail.messages)} messages · ${fmtTokens(
                      detail.tokens,
                    )}${detail.cost == null ? "" : ` · ${fmtCost(detail.cost)}`}`
                  : "Tap a day for its detail"}
              </Text>
            </View>

            <View
              style={s.card}
              onLayout={(e: LayoutChangeEvent) => setChartWidth(e.nativeEvent.layout.width - 28)}
            >
              <Text style={s.cardTitle}>
                {period === "year"
                  ? "Messages by month"
                  : `Messages · last ${PERIOD_DAYS[period]} days`}
              </Text>
              {chartWidth > 0 ? (
                <MiniBarChart
                  bars={bars}
                  width={chartWidth}
                  selected={period === "year" ? null : selected}
                  onSelect={period === "year" ? undefined : setSelected}
                />
              ) : null}
            </View>

            {agents.length ? (
              <View style={s.card}>
                <Text style={s.cardTitle}>By agent</Text>
                {agents.map((a) => (
                  <View key={a.agent} style={s.agentRow}>
                    <AgentLogo agent={a.agent} size={15} />
                    <Text style={s.agentName}>{agentLabel(a.agent)}</Text>
                    {/* An agent that reports no usage still did work — show its
                      session count rather than a bare "0 · $0.00", which reads
                      as "you never used it". */}
                    {a.tokens > 0 ? (
                      <>
                        <Text style={s.agentStat}>{fmtTokens(a.tokens)}</Text>
                        <Text style={a.cost == null ? s.agentSessions : s.agentCost}>
                          {a.cost == null ? "no price reported" : fmtCost(a.cost)}
                        </Text>
                      </>
                    ) : (
                      <Text style={s.agentSessions}>
                        {fmtCount(a.sessions)} {a.sessions === 1 ? "session" : "sessions"}
                      </Text>
                    )}
                  </View>
                ))}
              </View>
            ) : null}

            {partial.length ? (
              <Text style={s.caveat}>
                {partial.map(agentLabel).join(" and ")} {partial.length > 1 ? "report" : "reports"}{" "}
                no token usage — those sessions count toward activity but not spend.
              </Text>
            ) : null}
          </>
        )}
      </ScrollView>

      {/* Offscreen capture target — mounted only while sharing so it never
        costs a layout pass during normal scrolling. */}
      {sharing ? (
        <View style={s.offscreen} pointerEvents="none">
          <View ref={shareRef} collapsable={false} style={s.shareTarget}>
            <DashboardShareCard
              days={heat}
              totals={now}
              streak={run}
              period={period}
              costComplete={costComplete}
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.bg },
  content: { paddingHorizontal: 12, gap: 12 },
  shrink: { flexShrink: 1 },
  pressed: { opacity: 0.6 },
  headerRow: { flexDirection: "row", alignItems: "flex-end", gap: 8, paddingHorizontal: 2 },
  title: { fontSize: 30, fontWeight: "700", color: theme.colors.fg },
  subtitle: { marginTop: 2, fontSize: 13, color: theme.colors.fgMuted },
  shareBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginLeft: "auto",
    marginBottom: 4,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(124, 111, 240, 0.4)",
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  shareLabel: { fontSize: 13, fontWeight: "600", color: theme.colors.accent },
  segment: {
    flexDirection: "row",
    gap: 4,
    borderRadius: 10,
    backgroundColor: theme.colors.surfaceAlt,
    padding: 3,
  },
  segmentItem: { flex: 1, alignItems: "center", borderRadius: 8, paddingVertical: 7 },
  segmentItemOn: { backgroundColor: theme.colors.accent },
  segmentLabel: { fontSize: 13, fontWeight: "600", color: theme.colors.fgMuted },
  segmentLabelOn: { color: theme.colors.onAccent },
  loading: { paddingVertical: 48, alignItems: "center" },
  emptyWrap: { paddingVertical: 48, paddingHorizontal: 24, alignItems: "center", gap: 6 },
  emptyEmoji: { fontSize: 34 },
  emptyTitle: { fontSize: 17, fontWeight: "600", color: theme.colors.fg },
  emptyBody: { textAlign: "center", fontSize: 13, color: theme.colors.fgMuted },
  tiles: { flexDirection: "row", gap: 12 },
  streakRow: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
    paddingVertical: 12,
  },
  streakItem: { flex: 1, alignItems: "center", gap: 2 },
  streakValue: {
    fontFamily: "JetBrainsMono",
    fontSize: 20,
    fontWeight: "600",
    color: theme.colors.fg,
  },
  streakLabel: {
    fontSize: 10,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    color: theme.colors.fgFaint,
  },
  streakDivider: { width: 1, height: 26, backgroundColor: theme.colors.border },
  card: {
    gap: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
    padding: 14,
  },
  cardTitle: {
    fontSize: 11,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    color: theme.colors.fgFaint,
  },
  detailLine: { fontSize: 12, color: theme.colors.fgMuted },
  agentRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  agentName: { flex: 1, fontSize: 14, color: theme.colors.fg },
  agentStat: { fontFamily: "JetBrainsMono", fontSize: 12, color: theme.colors.fgMuted },
  agentCost: {
    minWidth: 68,
    textAlign: "right",
    fontFamily: "JetBrainsMono",
    fontSize: 12,
    color: theme.colors.fg,
  },
  agentSessions: { fontSize: 12, color: theme.colors.fgFaint },
  caveat: { paddingHorizontal: 4, fontSize: 11, lineHeight: 16, color: theme.colors.fgFaint },
  // Parked far offscreen: react-native-view-shot can capture a mounted view the
  // user never sees, which is how the share image gets its own fixed layout.
  offscreen: { position: "absolute", left: -9999, top: 0 },
  shareTarget: { width: SHARE_CARD_WIDTH, height: SHARE_CARD_HEIGHT },
}));
