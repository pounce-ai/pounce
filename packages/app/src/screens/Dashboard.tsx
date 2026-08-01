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
import { Animated, LinearTransition } from "../components/animation";
import { ContributionGraph } from "../components/ContributionGraph";
import { QuotaCard } from "../components/QuotaCard";
import { MiniBarChart } from "../components/MiniBarChart";
import { StatTile } from "../components/StatTile";
import { ActivitySkeleton } from "../components/Skeleton";
import {
  DashboardShareCard,
  SHARE_CARD_HEIGHT,
  SHARE_CARD_WIDTH,
} from "../components/DashboardShareCard";
import { captureAvailable, shareDashboard } from "../services/share";

const YEAR = 365;
/** Matches the desktop sidebar's first section header offset (Sidebar's `grp`
 *  paddingTop), so the two columns' content lines up across the seam. */
const SIDEBAR_SECTION_TOP = 9;
/** The height tween when the period changes. Short and eased — the point is to
 *  show that one thing became another, not to put on a show.
 *
 *  Carried by a bare Animated.View wrapper with no style of its own: unistyles
 *  styles are proxies Reanimated reads as empty objects ("an empty object is
 *  not a valid style value"), so the styled View has to sit INSIDE the animated
 *  one rather than being it. */
const HEAT_TRANSITION = LinearTransition.duration(220);

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
  const [heatWidth, setHeatWidth] = useState(0);
  const [chartHeight, setChartHeight] = useState(0);
  const [sharing, setSharing] = useState(false);
  const shareRef = useRef<View>(null);

  // Pull-to-refresh means "go look again", not "show me the same answer" — so it
  // asks the host to bypass its own 20s cache. Ordinary refetches (mount, stale
  // time) deliberately don't, since re-parsing every transcript is expensive.
  const forceFresh = useRef(false);
  const q = useQuery({
    queryKey: ["activity", YEAR],
    queryFn: () => {
      const fresh = forceFresh.current;
      forceFresh.current = false;
      return fetchActivity(YEAR, { fresh });
    },
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
  // The heatmap follows the period picker like everything else on this screen.
  // Quantized over the WINDOW rather than the year, so the ramp describes the
  // days you're looking at — a quiet week shown against a year's quartiles
  // would be uniformly blank and say nothing.
  const heat = useMemo(() => quantize(periodSlice(year, period).window), [year, period]);
  /** A year is the weekday calendar; shorter windows are a strip of days (see
   *  ContributionGraph's `rows`) — a week as a 7-row grid is two columns. */
  const heatRows = period === "year" ? 7 : 1;
  const heatTitle = period === "year" ? "Last 12 months" : `Last ${PERIOD_DAYS[period]} days`;
  const { window, previous } = useMemo(() => periodSlice(year, period), [year, period]);
  const now = useMemo(() => sumDays(window), [window]);
  const before = useMemo(() => sumDays(previous), [previous]);
  // Two readings, deliberately.
  //
  //   `run`       the whole year — the all-time best, which the subtitle shows.
  //   `windowRun` the chosen period — what the streak row shows.
  //
  // The row scopes ALL THREE of its figures, not just two. Mixing scopes looked
  // broken: an all-time "36 day streak" beside a week's "7 longest" reads as a
  // contradiction, since a longest can't be under a current. Windowed, every
  // figure answers the same question ("in these days…") and they agree. Nothing
  // is lost — the all-time best still has its place in the subtitle above.
  const run = useMemo(() => streaks(year), [year]);
  const windowRun = useMemo(() => streaks(window), [window]);
  // One agent list for the whole screen: everything with activity in this
  // window, plus everything that reported a plan. Plan usage listing three
  // agents while "By agent" listed two was the same data answering two
  // questions, and it read as broken.
  const knownAgents = useMemo(
    () => [...new Set((quotaQ.data ?? []).map((q) => q.agent))],
    [quotaQ.data],
  );
  const agents = useMemo(() => byAgentTotals(window, knownAgents), [window, knownAgents]);
  const partial = useMemo(() => partialAgents(q.data?.coverage ?? {}), [q.data]);
  const costComplete = q.data?.totals.costComplete !== false;
  // Estimated is a property of the SLICE on screen, not the whole series: a
  // week whose every dollar was agent-reported shouldn't inherit the "est."
  // marker from an older month that ccusage had to price.
  const estimated = now.costEstimated === true;

  // Trend bars: a day each for week/month, a month each for year (365 bars
  // would be 1px wide and unreadable).
  const bars = useMemo(() => {
    if (period !== "year") {
      return window.map((d) => ({ key: d.date, value: d.messages }));
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
  // "Nothing here" is a claim about the DATA, so it may only be made when the
  // data actually arrived. A failed read is `q.isError`, handled separately —
  // and sessions count, since agents that publish no dated tokens (opencode,
  // cursor) appear only as sessions and the screen has a tile for them.
  const empty =
    !q.isLoading && !q.isError && now.messages === 0 && now.sessions === 0 && run.longest === 0;

  // A period picker is a toolbar control, not a page section. Full-bleed it
  // became a 960pt bar with a slab of accent in the middle; on desktop it sits
  // in the header beside the title, sized to its own labels.
  const segment = (
    <View style={[s.segment, IS_DESKTOP && s.segmentDesktop]}>
      {PERIODS.map((p) => (
        <Pressable
          key={p}
          onPress={() => setPeriod(p)}
          style={[
            s.segmentItem,
            IS_DESKTOP && s.segmentItemDesktop,
            p === period && s.segmentItemOn,
          ]}
        >
          <Text
            style={[
              s.segmentLabel,
              IS_DESKTOP && s.segmentLabelDesktop,
              p === period && s.segmentLabelOn,
            ]}
          >
            {PERIOD_LABEL[p]}
          </Text>
        </Pressable>
      ))}
    </View>
  );

  return (
    <View style={s.root}>
      <ScrollView
        contentContainerStyle={[
          s.content,
          // Desktop gets a capped, centred column: the same stack run edge to
          // edge across a 1400pt window leaves stat tiles a foot apart and a
          // heat-map stretched into a smear.
          IS_DESKTOP && s.contentDesktop,
          // Desktop starts level with the sidebar's first section header, which
          // sits 9pt under its own titlebar row — both columns begin at the same
          // y instead of the content pane hanging 17pt lower. (No notch here, so
          // the phone's insets.top + 8 doesn't apply.)
          {
            paddingTop: IS_DESKTOP ? SIDEBAR_SECTION_TOP : insets.top + 8,
            paddingBottom: insets.bottom + 32,
          },
        ]}
        refreshControl={
          <RefreshControl
            refreshing={q.isFetching && !q.isLoading}
            onRefresh={() => {
              forceFresh.current = true;
              return q.refetch();
            }}
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
          {IS_DESKTOP ? <View style={s.headerSpacer} /> : null}
          {IS_DESKTOP ? segment : null}
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

        {/* Period selector — drives everything below it, the heatmap included:
          the grid shows the chosen window, not a fixed year. */}
        {IS_DESKTOP ? null : segment}

        {q.isLoading ? (
          <ActivitySkeleton />
        ) : q.isError ? (
          // Couldn't read — say so and offer another go, rather than reporting
          // a zero we don't know to be true. The first call on a machine with
          // months of history parses every transcript it hasn't summarised yet,
          // and that can outlast the request.
          <View style={s.emptyWrap}>
            <Text style={s.emptyEmoji}>🐾</Text>
            <Text style={s.emptyTitle}>Couldn&apos;t read your history</Text>
            <Text style={s.emptyBody}>
              The machine didn&apos;t answer in time. If it&apos;s been a while since you opened
              Pounce there, it may still be reading through your transcripts.
            </Text>
            <Pressable
              onPress={() => {
                forceFresh.current = false;
                void q.refetch();
              }}
              style={({ pressed }) => [s.shareBtn, pressed && s.pressed]}
            >
              <Text style={s.shareLabel}>Try again</Text>
            </Pressable>
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
            {/* Height changes a lot between periods — a 7-row year calendar
                down to a single strip of days — and snapping between them read
                as a glitch. LinearTransition tweens the card and lets the tiles
                below slide up rather than jump. Desktop's animation seam strips
                `layout`, so it simply renders the end state. */}
            <Animated.View layout={HEAT_TRANSITION}>
              <View
                style={s.card}
                onLayout={(e: LayoutChangeEvent) => setHeatWidth(e.nativeEvent.layout.width - 28)}
              >
                <Text style={s.cardTitle}>{heatTitle}</Text>
                <ContributionGraph
                  days={heat}
                  rows={heatRows}
                  selected={selected}
                  onSelectDay={setSelected}
                  // The year grid fills only on desktop: 53 weeks stretched across
                  // a 390pt phone would make each day a sliver, so the phone keeps
                  // fixed cells and scrolls. A short window is the opposite case —
                  // few columns, so it fills the card everywhere (capped by
                  // MAX_STEP, or a week would be seven slabs).
                  fillWidth={
                    heatWidth > 0 && (heatRows === 1 || IS_DESKTOP) ? heatWidth : undefined
                  }
                />
                <Text numberOfLines={1} style={s.detailLine}>
                  {detail
                    ? `${fmtDayLabel(detail.date)} — ${fmtCount(detail.messages)} messages · ${fmtTokens(
                        detail.tokens,
                      )}${
                        detail.cost == null
                          ? ""
                          : ` · ${detail.costEstimated ? "~" : ""}${fmtCost(detail.cost)}${
                              detail.costEstimated ? " est." : ""
                            }`
                      }`
                    : IS_DESKTOP
                      ? "Click a day for its detail"
                      : "Tap a day for its detail"}
                </Text>
              </View>
            </Animated.View>

            {/* Tokens lead, not dollars: token counts are the agents' own
              numbers and always exist, whereas a dollar figure only appears
              for turns an agent actually priced (see the caveat below). */}
            <Animated.View layout={HEAT_TRANSITION}>
              <View style={[s.tileWrap, IS_DESKTOP && s.rowDesktop]}>
                <View style={[s.tiles, IS_DESKTOP && s.flex1]}>
                  <StatTile
                    label="Tokens"
                    value={fmtTokens(now.tokens)}
                    delta={fmtDelta(delta(now.tokens, before.tokens))}
                    icon="sparkles"
                    hero
                  />
                  {/* The label itself changes with provenance: "Reported" is what
                  agents billed, "Estimated" is tokens priced at public list
                  rates. Calling a list-price figure "reported spend" would be
                  the exact lie this dashboard is built to avoid. */}
                  <StatTile
                    label={estimated ? "Estimated spend" : "Reported spend"}
                    value={
                      now.cost == null
                        ? "—"
                        : `${costComplete && !estimated ? "" : "~"}${fmtCost(now.cost)}`
                    }
                    delta={fmtDelta(delta(now.cost, before.cost))}
                    hint={
                      now.cost == null
                        ? "not reported"
                        : estimated
                          ? "list price"
                          : costComplete
                            ? null
                            : "partial"
                    }
                    icon="card-outline"
                    inverse
                  />
                </View>
                <View style={[s.tiles, IS_DESKTOP && s.flex1]}>
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
              </View>
            </Animated.View>

            <QuotaCard quotas={quotaQ.data ?? []} agents={agents.map((a) => a.agent)} />

            <View style={s.streakRow}>
              <View style={s.streakItem}>
                <Text style={s.streakValue}>{windowRun.current}</Text>
                <Text style={s.streakLabel}>day streak</Text>
              </View>
              <View style={s.streakDivider} />
              <View style={s.streakItem}>
                <Text style={s.streakValue}>{windowRun.longest}</Text>
                <Text style={s.streakLabel}>longest</Text>
              </View>
              <View style={s.streakDivider} />
              <View style={s.streakItem}>
                <Text style={s.streakValue}>{windowRun.active}</Text>
                <Text style={s.streakLabel}>active days</Text>
              </View>
            </View>

            {/* Chart and agent totals are both half-width content; side by side
                they fill the row instead of each getting a lonely band. */}
            <View style={[s.tileWrap, IS_DESKTOP && s.rowDesktop]}>
              <View
                style={[s.card, IS_DESKTOP && s.flex1]}
                onLayout={(e: LayoutChangeEvent) => setChartWidth(e.nativeEvent.layout.width - 28)}
              >
                <Text style={s.cardTitle}>
                  {period === "year"
                    ? "Messages by month"
                    : `Messages · last ${PERIOD_DAYS[period]} days`}
                </Text>
                {/* This card shares a row with "By agent", so its height is set
                    by whichever is taller. Measure the space left under the
                    title and draw into all of it, instead of a fixed 96pt bar
                    area with a gap beneath. */}
                <View
                  style={IS_DESKTOP ? s.chartFill : undefined}
                  onLayout={
                    IS_DESKTOP
                      ? (e: LayoutChangeEvent) => setChartHeight(e.nativeEvent.layout.height)
                      : undefined
                  }
                >
                  {chartWidth > 0 ? (
                    <MiniBarChart
                      bars={bars}
                      width={chartWidth}
                      height={IS_DESKTOP && chartHeight > 0 ? chartHeight : undefined}
                      selected={period === "year" ? null : selected}
                      onSelect={period === "year" ? undefined : setSelected}
                    />
                  ) : null}
                </View>
              </View>

              {agents.length ? (
                <View style={[s.card, IS_DESKTOP && s.flex1]}>
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
                            {a.cost == null
                              ? "no price reported"
                              : a.costEstimated
                                ? `~${fmtCost(a.cost)} est.`
                                : fmtCost(a.cost)}
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
            </View>

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
  // Toolbar proportions: content-width, 26pt tall, with a border so the track
  // is visible on a light window (surfaceAlt is white there).
  segmentDesktop: {
    alignSelf: "flex-end",
    gap: 2,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: 2,
  },
  segmentItemDesktop: { flex: 0, minWidth: 62, borderRadius: 6, paddingVertical: 4 },
  segmentLabelDesktop: { fontSize: 12 },
  headerSpacer: { flex: 1 },
  segmentLabel: { fontSize: 13, fontWeight: "600", color: theme.colors.fgMuted },
  segmentLabelOn: { color: theme.colors.onAccent },
  loading: { paddingVertical: 48, alignItems: "center" },
  emptyWrap: { paddingVertical: 48, paddingHorizontal: 24, alignItems: "center", gap: 6 },
  emptyEmoji: { fontSize: 34 },
  emptyTitle: { fontSize: 17, fontWeight: "600", color: theme.colors.fg },
  emptyBody: { textAlign: "center", fontSize: 13, color: theme.colors.fgMuted },
  tiles: { flexDirection: "row", gap: 12 },
  // Desktop layout helpers. `tileWrap` keeps the parent's 12pt rhythm when it
  // wraps a pair of rows on mobile; on desktop it turns that pair into a row.
  tileWrap: { gap: 12 },
  // `stretch`, not `flex-start`: the two halves hold different content (the
  // hero Tokens tile is taller than a plain one), so sizing each to its own
  // content left the four tiles bottoming out on three different lines.
  rowDesktop: { flexDirection: "row", alignItems: "stretch" },
  flex1: { flex: 1 },
  // Claims the leftover height in the chart card so it can be measured; the
  // floor keeps it usable when the neighbouring card is short.
  chartFill: { flex: 1, minHeight: 96, justifyContent: "flex-end" },
  contentDesktop: {
    maxWidth: 1120,
    width: "100%",
    alignSelf: "center",
    paddingHorizontal: 24,
  },
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
