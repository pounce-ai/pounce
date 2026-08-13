import { useCallback, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  View,
  type LayoutChangeEvent,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useQuery } from "@tanstack/react-query";
import { Stack, useRouter } from "expo-router";
import { PounceIcon } from "../ui/native/Icon";
import { AgentLogo, IS_DESKTOP } from "../ui";
import { agentLabel } from "../ui/tokens";
import { scaledWidth } from "../ui/layout";
import { fmtCost, fmtCount, fmtDayLabel, fmtDelta, fmtTokens } from "../ui/format";
import { fetchActivity, fetchQuota } from "../services/bridge";
import { useDevices } from "../state/db/hooks";
import { ConnectFlow } from "../components/ConnectFlow";
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
import { CHART_GUTTER, UsageChart } from "../components/UsageChart";
import { bucketByMonth } from "../components/usageSeries";
import { PeriodPicker } from "../components/PeriodPicker";
import { ScreenRoot } from "../components/ScreenRoot";
import { TabHeaderIcon } from "../components/TabHeaderIcon";
import { StatTile } from "../components/StatTile";
import type { MetricKey } from "./Metric";
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

/** The desktop column. A flat 1120 was the whole rule before, and on a 1920pt
 *  window it left ~290pt of dead gutter down each side — the pane is wide, the
 *  content refused to use it. 0.86 of the pane keeps a margin without donating
 *  the window to it, the 1120 floor means a laptop-sized pane is no narrower
 *  than it already was, and 1600 is where a stat tile row stops being scannable
 *  in one look and the heat map goes back to being a smear. Measured off the
 *  ScrollView, not useWindowDimensions: on macOS that reports the SCREEN, and
 *  the pane is the window minus the sidebar minus whatever the dock took. */
const CONTENT_WIDTH = { fraction: 0.86, min: 1120, max: 1600 };

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
  const devices = useDevices();
  const { theme } = useUnistyles();
  const router = useRouter();
  const [period, setPeriod] = useState<Period>("month");
  const [selected, setSelected] = useState<string | null>(null);
  const [chartWidth, setChartWidth] = useState(0);
  const [heatWidth, setHeatWidth] = useState(0);
  // The derived cap, not the raw measurement: below ~1300pt and above ~1860pt
  // scaledWidth is constant, so storing the pane width made every pixel of a
  // window drag a fresh state value and re-rendered the whole screen — and the
  // heat grid and chart re-measured off the back of it — for identical output.
  const [contentMax, setContentMax] = useState(CONTENT_WIDTH.min);
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
  // How much of the window's token total was re-read context. A subscript on
  // the Tokens tile, not a deduction from it.
  const cachedTokens = useMemo(
    () => window.reduce((n, d) => n + (d.usage?.cacheRead ?? 0), 0),
    [window],
  );
  // Each tile opens its own page, carrying the period it was tapped in so the
  // detail always opens on the window you were looking at.
  const openMetric = useCallback(
    (key: MetricKey) => router.push({ pathname: "/metric", params: { key, period } }),
    [router, period],
  );
  // One agent list for the whole screen: everything with activity in this
  // window, plus everything that reported a plan. Plan usage listing three
  // agents while "By agent" listed two was the same data answering two
  // questions, and it read as broken.
  const knownAgents = useMemo(
    () => [...new Set((quotaQ.data ?? []).map((q) => q.agent))],
    [quotaQ.data],
  );
  // …but an agent with NOTHING to report is noise in both. An installed CLI you
  // never ran, with no plan to speak of, was taking a card to say "no plan
  // detected" and a row to say "0 sessions" — pushing the agents you actually
  // use into a squeeze. Keep an agent if it did something in this window, or if
  // it has a plan worth stating (a named tier, a meter, or a measured window).
  const agents = useMemo(() => {
    const quota = new Map((quotaQ.data ?? []).map((entry) => [entry.agent, entry]));
    return byAgentTotals(window, knownAgents).filter((a) => {
      if (a.sessions > 0 || a.messages > 0 || a.tokens > 0) return true;
      const entry = quota.get(a.agent);
      return !!(entry?.planType || entry?.windows.length || entry?.blocks?.current);
    });
  }, [window, knownAgents, quotaQ.data]);
  const partial = useMemo(() => partialAgents(q.data?.coverage ?? {}), [q.data]);
  const costComplete = q.data?.totals.costComplete !== false;
  // Estimated is a property of the SLICE on screen, not the whole series: a
  // week whose every dollar was agent-reported shouldn't inherit the "est."
  // marker from an older month that ccusage had to price.
  const estimated = now.costEstimated === true;

  /** A year is charted at MONTH resolution, with the per-agent split carried
   *  through the fold — same chart, same colours, coarser buckets. */
  const chartDays = useMemo(
    () => (period === "year" ? bucketByMonth(window) : window),
    [window, period],
  );
  /** Colour order for the chart: busiest first, so the dominant series keeps the
   *  same hue as the period changes. */
  const chartAgents = useMemo(
    () =>
      agents
        .filter((a) => (a.messages ?? 0) > 0)
        .sort((x, y) => (y.messages ?? 0) - (x.messages ?? 0))
        .map((a) => a.agent),
    [agents],
  );

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

  // Sharing a card of zeroes is a worse outcome than no button: it looks like
  // the app failed. Gated on there being activity at all (`empty` below).
  const canShare = !IS_DESKTOP && captureAvailable();
  /** A machine has been paired at all — not whether it answers right now. A
   *  brief disconnect shouldn't wipe the charts you were just reading. */
  const paired = devices.length > 0;
  // "Nothing here" is a claim about the DATA, so it may only be made when the
  // data actually arrived. A failed read is `q.isError`, handled separately —
  // and sessions count, since agents that publish no dated tokens (opencode,
  // cursor) appear only as sessions and the screen has a tile for them.
  const empty =
    !q.isLoading && !q.isError && now.messages === 0 && now.sessions === 0 && run.longest === 0;

  // A period picker is a toolbar control, not a page section. On desktop it
  // sits in the header beside the title, sized to its own labels; on the phones
  // it is the platform's own segmented control, full width under the title.
  const segment = <PeriodPicker value={period} onChange={setPeriod} periods={PERIODS} />;

  /** One sentence about the window, in every state it can be in. "0-day best
   *  streak" is a statistic about nothing — true with no machine paired, and
   *  equally true when the read FAILED and every number below is a zero we
   *  never actually got. */
  const streakLine = !paired
    ? "Nothing connected"
    : q.isLoading
      ? "Reading your history…"
      : q.isError
        ? "History unavailable"
        : `${fmtCount(run.longest)}-day best streak`;

  return (
    <ScreenRoot style={s.root}>
      <TabHeaderIcon sf="chart.bar.fill" md="insert-chart" />
      {/* Share lives in the native bar. Gated exactly as the inline button was:
          nothing to share without a machine, an empty window, or a failed read. */}
      {IS_DESKTOP || !(canShare && paired && !empty && !q.isError) ? null : (
        <Stack.Toolbar placement="right">
          {/* Android gets a View rather than a Button: its Compose host drops a
              bare Label and cannot read an SF Symbol, so the button rendered as
              an empty tap target. Same fork as Home's toolbar. */}
          {Platform.OS !== "ios" ? (
            <Stack.Toolbar.View>
              <Pressable
                onPress={onShare}
                disabled={sharing || q.isLoading}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Share"
                style={({ pressed }) => [s.barAction, pressed && s.pressed]}
              >
                {sharing ? (
                  <ActivityIndicator size="small" color={theme.colors.accent} />
                ) : (
                  <PounceIcon name="share-outline" size={21} color={theme.colors.accent} />
                )}
              </Pressable>
            </Stack.Toolbar.View>
          ) : (
            <Stack.Toolbar.Button
              onPress={() => void onShare()}
              disabled={sharing || q.isLoading}
              accessibilityLabel="Share"
            >
              <Stack.Toolbar.Icon sf="square.and.arrow.up" />
            </Stack.Toolbar.Button>
          )}
        </Stack.Toolbar>
      )}
      <ScrollView
        // iOS ties the large title to this scroll view — see ScreenRoot.
        contentInsetAdjustmentBehavior="automatic"
        onLayout={
          IS_DESKTOP
            ? (e: LayoutChangeEvent) =>
                setContentMax(scaledWidth(e.nativeEvent.layout.width, CONTENT_WIDTH))
            : undefined
        }
        contentContainerStyle={[
          s.content,
          // Desktop gets a capped, centred column: the same stack run edge to
          // edge across a 1400pt window leaves stat tiles a foot apart and a
          // heat-map stretched into a smear.
          IS_DESKTOP && s.contentDesktop,
          // …but the cap follows the pane rather than being one number, or a
          // large display pays for its width in gutter. See CONTENT_WIDTH.
          IS_DESKTOP && { maxWidth: contentMax },
          // Desktop starts level with the sidebar's first section header, which
          // sits 9pt under its own titlebar row — both columns begin at the same
          // y instead of the content pane hanging 17pt lower. (No notch here, so
          // the phone's insets.top + 8 doesn't apply.)
          s.contentPad,
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
        {/* Desktop draws its own title row; mobile's lives in the native bar. */}
        {IS_DESKTOP ? (
          <View style={s.headerRow}>
            <View style={s.shrink}>
              <Text style={s.title}>Activity</Text>
              <Text style={s.subtitle}>{streakLine}</Text>
            </View>
            <View style={s.headerSpacer} />
            {segment}
            {canShare && paired && !empty && !q.isError ? (
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
        ) : (
          /* The streak line has no home in a large title, and it carries the
             loading and error states as well as the number — so it becomes a
             caption over the period control, the same treatment Metric gives
             its date range. */
          <Text style={s.subtitle}>{streakLine}</Text>
        )}

        {/* Period selector — drives everything below it, the heatmap included:
          the grid shows the chosen window, not a fixed year. Hidden with
          nothing paired: it would narrow an empty set three ways. */}
        {IS_DESKTOP || !paired ? null : segment}

        {!paired ? (
          // Analytics are read from a machine, so with none paired there is
          // nothing to load and a skeleton would be a lie about work in
          // progress. Same self-advancing card as Home, so the fix is here
          // rather than a sentence pointing at another screen.
          <View style={s.emptyWrap}>
            <Text style={s.emptyTitle}>Nothing to chart yet</Text>
            <Text style={s.emptyBody}>
              {IS_DESKTOP
                ? "Reading this Mac's history — give it a moment."
                : "Connect a computer — its history is what fills this in."}
            </Text>
            <ConnectFlow />
          </View>
        ) : q.isLoading ? (
          <ActivitySkeleton />
        ) : q.isError ? (
          // Couldn't read — say so and offer another go, rather than reporting
          // a zero we don't know to be true. The first call on a machine with
          // months of history parses every transcript it hasn't summarised yet,
          // and that can outlast the request.
          <View style={s.emptyWrap}>
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
                    // The headline is the agents' own reported total; this says
                    // how much of it was context re-read from cache rather than
                    // new input. Shown beside the figure, never taken off it —
                    // subtracting would produce a number that matches no
                    // agent's own profile page.
                    hint={cachedTokens > 0 ? `${fmtTokens(cachedTokens)} cached` : null}
                    icon="sparkles"
                    hero
                    onPress={() => openMetric("tokens")}
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
                    onPress={() => openMetric("spend")}
                  />
                </View>
                <View style={[s.tiles, IS_DESKTOP && s.flex1]}>
                  <StatTile
                    label="Sessions"
                    value={fmtCount(now.sessions)}
                    delta={fmtDelta(delta(now.sessions, before.sessions))}
                    icon="chatbubbles-outline"
                    onPress={() => openMetric("sessions")}
                  />
                  <StatTile
                    label="Messages"
                    value={fmtCount(now.messages)}
                    delta={fmtDelta(delta(now.messages, before.messages))}
                    icon="git-commit-outline"
                    onPress={() => openMetric("messages")}
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
                {/* The chart draws at its own fixed height on both platforms —
                    it carries an axis, a legend and a readout, so stretching it
                    to fill a desktop card would space those apart rather than
                    show more data. The card still shares a row with "By agent"
                    and is sized by whichever is taller. */}
                <View style={IS_DESKTOP ? s.chartFill : undefined}>
                  {chartWidth > 0 ? (
                    <UsageChart
                      days={chartDays}
                      agents={chartAgents}
                      metric="messages"
                      granularity={period === "year" ? "month" : "day"}
                      width={chartWidth - CHART_GUTTER}
                      // Controlled: the contribution heatmap above shares this
                      // selection, and two components holding private copies of
                      // it would disagree the moment you touched either.
                      selected={selected}
                      onSelect={setSelected}
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
    </ScreenRoot>
  );
}

const s = StyleSheet.create((theme, rt) => ({
  /** Safe-area padding in the sheet — applied natively, no re-render. */
  contentPad: {
    paddingTop: IS_DESKTOP ? SIDEBAR_SECTION_TOP : 0,
    paddingBottom: rt.insets.bottom + 32,
  },
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
    borderColor: theme.colors.accentLine,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  /** Android toolbar slot: see the fork at the call site. */
  barAction: { paddingHorizontal: 4 },
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
  // The cap itself is applied at the call site — it depends on the measured
  // pane, and a number here as well would be a second source of truth.
  contentDesktop: {
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
