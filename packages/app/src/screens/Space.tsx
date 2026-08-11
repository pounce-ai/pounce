/**
 * One Space — what this project has cost, and what it tells your agents.
 *
 * A Space is one repository on one machine. Deliberately a SINGLE space rather
 * than a list-plus-detail browser: on desktop the sidebar is already the list,
 * and on a phone the Home screen is. Entering a space is one act — it narrows
 * what you see and opens this page.
 *
 * Metrics are per-space by construction: the host folds the same transcript
 * scan the Activity screen uses over just this repo's threads. Dollars are only
 * the ones an agent reported for those threads — org billing totals and
 * list-price estimates are whole-machine numbers that can't be split per
 * project, so a quiet-looking spend here means "not attributable", never "$0".
 *
 * There is no year heatmap. A 53-week grid measures a person's consistency,
 * which is a real question on Activity and the wrong one here: projects are
 * worked in bursts and then go dormant, so per project it spent ten blank
 * months saying "not then".
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Platform, Pressable, ScrollView, Text, View, type LayoutChangeEvent } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useQuery } from "@tanstack/react-query";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import type { Session } from "@pounce/shared";
import { applyFilters, needsYou } from "../state/stores";
import { useIgnoredSet, useProjectNames, useThreads } from "../state/db/hooks";
import { deriveSpaces, spaceKeyOf, type Space } from "../state/spaces";
import {
  fetchActivity,
  fetchContextFiles,
  fetchSpaceActivity,
  type ContextFile,
} from "../services/bridge";
import {
  byAgentTotals,
  PERIOD_DAYS,
  periodSlice,
  streaks,
  sumDays,
  zeroFill,
  type ActivityDay,
  type Period,
} from "../services/activity";
import { CHART_GUTTER, UsageChart } from "../components/UsageChart";
import { bucketByMonth } from "../components/usageSeries";
import { ContextEditor } from "../components/ContextEditor";
import { PeriodPicker } from "../components/PeriodPicker";
import { PounceIcon } from "../ui/native/Icon";
import type { IoniconName } from "../ui/native/icon-map";
import { AgentLogo, AgentStatusIcon, IS_DESKTOP, SELECT_TEXT, timeAgo } from "../ui";
import { agentLabel } from "../ui/tokens";
import { fmtCost, fmtCount, fmtDayLabel, fmtTokens } from "../ui/format";

/**
 * How much history the per-space series covers.
 *
 * A year, and it costs no more than a quarter would: the host scans each
 * thread's transcript whole and caches by mtime, so `days` only trims the
 * window it reports back.
 */
const SERIES_DAYS = 365;

const PERIODS: Period[] = ["week", "month", "year"];

export default function SpaceScreen() {
  const params = useLocalSearchParams<{ key?: string }>();
  const threads = useThreads();
  const projectNames = useProjectNames();
  const ignored = useIgnoredSet();
  const { theme } = useUnistyles();

  // Derived from ALL threads, not a filtered view: this is a place you opened
  // deliberately, and a device/agent filter set for triage elsewhere shouldn't
  // empty it out. Ignored repos and dotfolders stay hidden — those are "never
  // show me this", not a transient narrowing.
  const visible = useMemo(
    () =>
      applyFilters(threads, {
        filters: { device: null, agent: null, repos: [] },
        ignored,
        repoName: (id) => projectNames[id] ?? id,
      }),
    [threads, ignored, projectNames],
  );

  const spaces = useMemo(
    () => deriveSpaces(visible, (id) => projectNames[id] ?? id.replace(/^repo:/, ""), needsYou),
    [visible, projectNames],
  );

  const space = useMemo(
    () => spaces.find((sp) => sp.key === params.key) ?? null,
    [spaces, params.key],
  );

  if (!space) {
    // A space exists only as long as its threads do — archive or ignore the
    // last one and this is pointing at nothing. Say so rather than silently
    // showing a different project's numbers.
    return (
      <View style={s.gone}>
        <PounceIcon name="folder-open-outline" size={28} color={theme.colors.fgFaint} />
        <Text style={s.goneTitle}>This space is empty</Text>
        <Text style={s.goneBody}>
          Its threads are gone — archived, filtered out, or on a machine that isn&apos;t paired any
          more.
        </Text>
      </View>
    );
  }

  return (
    <SpaceDetail
      // Remount per space: this owns fetches and editor drafts keyed to one
      // project, and carrying either across a switch is worse than a reload.
      key={space.key}
      space={space}
      sessions={visible.filter((t) => spaceKeyOf(t) === space.key)}
    />
  );
}

function SpaceDetail({ space, sessions }: { space: Space; sessions: Session[] }) {
  const router = useRouter();
  const { theme } = useUnistyles();
  const [period, setPeriod] = useState<Period>("month");
  const [day, setDay] = useState<string | null>(null);
  const [chartWidth, setChartWidth] = useState(0);
  // Which checkout's files to read. Root leads (see spaces.cwds); a repo with
  // worktrees gets a switcher, because each has its own files on disk.
  const [cwdIndex, setCwdIndex] = useState(0);
  const cwd = space.cwds[Math.min(cwdIndex, space.cwds.length - 1)] ?? null;

  const activityQ = useQuery({
    queryKey: ["space-activity", space.hostId, space.repoKey],
    queryFn: () => fetchSpaceActivity(space.hostId, space.repoKey, SERIES_DAYS),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  // The denominator for "share of your work" — every machine, every project.
  // Deliberately the SAME query key the Activity screen uses, so opening a
  // Space after glancing at Activity costs nothing.
  const allQ = useQuery({
    queryKey: ["activity", SERIES_DAYS],
    queryFn: () => fetchActivity(SERIES_DAYS),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const [files, setFiles] = useState<ContextFile[] | null>(null);
  const [ctxLoading, setCtxLoading] = useState(true);
  const [unreachable, setUnreachable] = useState(false);

  const loadContext = useCallback(async () => {
    if (!cwd) {
      setCtxLoading(false);
      setFiles([]);
      return;
    }
    setCtxLoading(true);
    const out = await fetchContextFiles(space.hostId, cwd);
    setUnreachable(out === null);
    setFiles(out?.files ?? []);
    setCtxLoading(false);
  }, [space.hostId, cwd]);

  useEffect(() => {
    void loadContext();
  }, [loadContext]);

  /** Fold a just-saved file back in without a round trip — the host returned
   *  the authoritative size/mtime, so re-reading would only add a flicker. */
  const onSaved = useCallback((file: ContextFile) => {
    setFiles((cur) => {
      const list = cur ?? [];
      const at = list.findIndex((f) => f.path === file.path);
      if (at < 0) return [...list, file];
      return list.map((f, i) => (i === at ? file : f));
    });
  }, []);

  const series = useMemo(() => zeroFill(activityQ.data?.days ?? [], SERIES_DAYS), [activityQ.data]);
  const { window } = useMemo(() => periodSlice(series, period), [series, period]);
  const now = useMemo(() => sumDays(window), [window]);
  /** The activity read failed (or hasn't landed): the tiles below have nothing
   *  real to show, so they show `—` rather than a manufactured 0. */
  const unread = !activityQ.isLoading && activityQ.data == null;

  const allNow = useMemo(() => {
    if (!allQ.data) return null;
    return sumDays(periodSlice(zeroFill(allQ.data.days, SERIES_DAYS), period).window);
  }, [allQ.data, period]);
  // Null unless there's a real denominator AND a real numerator: a share of an
  // unknown total is not 0%, and neither is a space that recorded nothing.
  const share = useMemo(() => {
    if (!allNow || allNow.tokens <= 0 || now.tokens <= 0) return null;
    return Math.min(1, now.tokens / allNow.tokens);
  }, [allNow, now.tokens]);

  const run = useMemo(() => streaks(series), [series]);
  const agents = useMemo(() => byAgentTotals(window, [...space.agents]), [window, space.agents]);
  /** Colour order for the chart: busiest first, so the series that dominates the
   *  space keeps the same hue whatever period is showing. */
  const chartAgents = useMemo(
    () =>
      agents
        .filter((a) => (a.messages ?? 0) > 0)
        .sort((x, y) => (y.messages ?? 0) - (x.messages ?? 0))
        .map((a) => a.agent),
    [agents],
  );
  /** A year is charted at MONTH resolution, with the per-agent split carried
   *  through the fold — same chart, same colours, coarser buckets. */
  const chartDays = useMemo(
    () => (period === "year" ? bucketByMonth(window) : window),
    [window, period],
  );
  const detailDay = useMemo(
    () => (day ? (series.find((d) => d.date === day) ?? null) : null),
    [day, series],
  );

  const attention = sessions.filter(needsYou);

  /**
   * This screen's two verbs, in one definition.
   *
   * Context is a property of the PROJECT, not of a thread — the same AGENTS.md
   * governs every session in this checkout. It used to hang off a thread's
   * environment menu, which put one project's setup behind whichever thread you
   * happened to have open.
   *
   * Rendered into the native header on mobile and inline on desktop, which has
   * no native header to put them in.
   */
  const openContext = () =>
    cwd &&
    router.push({
      pathname: "/context",
      params: { cwd, hostId: space.hostId, repoId: space.repoId },
    });
  const openNewTask = () =>
    router.push({
      pathname: "/new",
      params: cwd ? { cwd, hostId: space.hostId, repoId: space.repoId } : { repoId: space.repoId },
    });

  /** Desktop has no header bar to put them in, so it keeps the labelled pills
   *  inline — where a bordered button is the right shape. */
  const inlineActions = (
    <>
      {cwd ? (
        <Pressable
          onPress={openContext}
          style={({ pressed }) => [s.headerBtn, pressed && s.pressed]}
        >
          <PounceIcon name="document-text-outline" size={14} color={theme.colors.fgMuted} />
          <Text style={s.headerBtnLabel}>Project context</Text>
        </Pressable>
      ) : null}
      <Pressable onPress={openNewTask} style={({ pressed }) => [s.headerBtn, pressed && s.pressed]}>
        <PounceIcon name="add-circle" size={14} color={theme.colors.fgMuted} />
        <Text style={s.headerBtnLabel}>New task</Text>
      </Pressable>
    </>
  );

  return (
    <ScrollView
      style={s.root}
      // iOS ties the large title to this scroll view, and insets it for the bar
      // — so no top padding of our own on mobile. See ScreenRoot for the rule
      // about it having to be the screen's first child (it is: this IS the root).
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={[s.content, s.contentPad]}
    >
      {/* The space's name titles the header the STACK draws — which also gives
          this page the back control it never had: it used to be reachable only
          by the swipe gesture.

          The two ACTIONS ride in that header too. They used to sit beside the
          metadata line, which left neither enough room: the line truncated at
          "Dirghas-Mac-mini · 73 thread…" while the buttons spelled themselves
          out in full. A header bar is where a screen's verbs belong, and moving
          them there gives the line below the whole width.

          A no-op on desktop, where the router is shimmed — hence the fork
          below, which keeps drawing the name and the buttons inline. */}
      {/* The real toolbar API, not `headerRight`.
          `headerRight` is ONE toolbar item, so iOS 26 drew a single glass
          capsule around whatever it held — two icons jammed into one button.
          `Stack.Toolbar` declares each child as its own item, which is what
          gives them a capsule each, matching the back chevron beside them.
          Android renders the same children through Compose (no capsules there
          — it has no glass), which is why the icons are platform-forked below:
          `sf` is iOS-only, and an Android button with an unresolvable icon
          would be an empty tap target. */}
      {IS_DESKTOP ? null : (
        <Stack.Toolbar placement="right">
          {cwd ? (
            <Stack.Toolbar.Button onPress={openContext} accessibilityLabel="Project context">
              {Platform.OS === "ios" ? (
                <Stack.Toolbar.Icon sf="doc.text" />
              ) : (
                <Stack.Toolbar.Label>Context</Stack.Toolbar.Label>
              )}
            </Stack.Toolbar.Button>
          ) : null}
          <Stack.Toolbar.Button onPress={openNewTask} accessibilityLabel="New task">
            {Platform.OS === "ios" ? (
              <Stack.Toolbar.Icon sf="square.and.pencil" />
            ) : (
              <Stack.Toolbar.Label>New</Stack.Toolbar.Label>
            )}
          </Stack.Toolbar.Button>
        </Stack.Toolbar>
      )}
      <View style={s.header}>
        <View style={s.shrink}>
          {IS_DESKTOP ? (
            <Text selectable={SELECT_TEXT} numberOfLines={1} style={s.title}>
              {space.name}
            </Text>
          ) : null}
          <Text numberOfLines={1} style={s.subtitle}>
            {space.host} · {space.sessionCount} {space.sessionCount === 1 ? "thread" : "threads"} ·{" "}
            {space.liveCount} live · {`active ${timeAgo(space.lastActivityAt)}`}
          </Text>
        </View>
        {IS_DESKTOP ? (
          <>
            <View style={s.flex1} />
            {inlineActions}
          </>
        ) : null}
      </View>

      {cwd ? (
        <Text selectable={SELECT_TEXT} numberOfLines={1} style={s.path}>
          {cwd.replace(/^\/Users\/[^/]+/, "~")}
        </Text>
      ) : null}

      <PeriodPicker value={period} onChange={setPeriod} periods={PERIODS} />

      {/* The note goes ABOVE the tiles it qualifies. Below them the page
          contradicted itself top-to-bottom: four tiles asserting 0 tokens, 0
          messages, 0 threads, and only then a line admitting none of it was
          read. */}
      {activityQ.isLoading ? (
        <Text style={s.note}>Reading this project&apos;s history…</Text>
      ) : activityQ.data == null ? (
        <Text style={s.note}>
          Couldn&apos;t read activity from {space.host}. The rest of this page still works.
        </Text>
      ) : null}

      {/* `—` rather than 0 when the read failed: a zero is a claim about this
          project, and we don't have one. Matches "Reported spend", which has
          always said `—` for a number it doesn't know. */}
      <View style={s.tiles}>
        <Metric label="Tokens" value={unread ? "—" : fmtTokens(now.tokens)} icon="sparkles" />
        <Metric
          label="Messages"
          value={unread ? "—" : fmtCount(now.messages)}
          icon="git-commit-outline"
        />
      </View>
      <View style={s.tiles}>
        <Metric
          label="Threads started"
          value={unread ? "—" : fmtCount(now.sessions)}
          icon="chatbubbles-outline"
        />
        <Metric
          label="Reported spend"
          value={
            unread || now.cost == null ? "—" : `${now.costEstimated ? "~" : ""}${fmtCost(now.cost)}`
          }
          hint={
            unread
              ? null
              : now.cost == null
                ? "not reported"
                : now.costEstimated
                  ? "list price"
                  : null
          }
          icon="card-outline"
        />
      </View>

      {/* One card per question, like every other section on this page. These
          three used to share a card divided by hairlines, which made the page
          read in two different grouping idioms at once — hairline-separated
          sections above, separate cards below — for no reason either side of
          the boundary could explain. */}
      <View
        style={s.card}
        onLayout={(e: LayoutChangeEvent) => setChartWidth(e.nativeEvent.layout.width - 28)}
      >
        <Text style={s.cardTitle}>
          {period === "year" ? "Messages by month" : `Messages · last ${PERIOD_DAYS[period]} days`}
        </Text>
        {chartWidth > 0 ? (
          <UsageChart
            days={chartDays}
            agents={chartAgents}
            metric="messages"
            granularity={period === "year" ? "month" : "day"}
            width={chartWidth - CHART_GUTTER}
            // Controlled, because the footer below reads the same selection —
            // the chart's own readout names the agents, the footer gives the
            // space's totals for that bucket.
            selected={day}
            onSelect={setDay}
          />
        ) : null}
        <Text numberOfLines={1} style={s.cardFoot}>
          {detailDay
            ? `${fmtDayLabel(detailDay.date)} — ${fmtCount(detailDay.messages)} messages · ${fmtTokens(detailDay.tokens)}`
            : IS_DESKTOP
              ? "Click a point for its detail"
              : "Tap a point for its detail"}
        </Text>
      </View>

      <View style={s.card}>
        <ShareOfWork share={share} space={space} mine={now.tokens} total={allNow?.tokens ?? null} />
      </View>

      <View style={s.card}>
        <Cadence series={series} run={run} space={space} loading={activityQ.isLoading} />
      </View>

      <View style={s.card}>
        <Text style={s.cardTitle}>By agent</Text>
        {agents.length ? (
          agents.map((a) => (
            <View key={a.agent} style={s.agentRow}>
              <AgentLogo agent={a.agent} size={15} />
              <Text style={s.agentName}>{agentLabel(a.agent)}</Text>
              {a.tokens > 0 ? (
                <Text style={s.agentStat}>{fmtTokens(a.tokens)}</Text>
              ) : (
                <Text style={s.agentFaint}>
                  {fmtCount(a.sessions)} {a.sessions === 1 ? "thread" : "threads"}
                </Text>
              )}
              <Text style={a.cost == null ? s.agentFaint : s.agentCost}>
                {a.cost == null ? "—" : `${a.costEstimated ? "~" : ""}${fmtCost(a.cost)}`}
              </Text>
            </View>
          ))
        ) : (
          <Text style={s.cardFoot}>No agent activity in this window.</Text>
        )}
      </View>

      {attention.length ? (
        <View style={s.card}>
          <Text style={s.cardTitle}>Waiting on you</Text>
          {attention.map((t) => (
            <Pressable
              key={t.id}
              onPress={() => router.push(`/session/${t.id}`)}
              style={({ pressed }) => [s.waitRow, pressed && s.rowPressed]}
            >
              <AgentStatusIcon agent={t.agent} activity={t.activity} size={12} />
              <Text numberOfLines={1} style={s.waitTitle}>
                {t.title}
              </Text>
              <Text style={s.waitTime}>{timeAgo(t.updatedAt)}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      <View style={s.card}>
        <View style={s.contextHead}>
          <Text style={s.cardTitle}>Agent instructions</Text>
          <View style={s.flex1} />
          {space.cwds.length > 1 ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.cwdScroll}>
              <View style={s.cwdRow}>
                {space.cwds.map((c, i) => (
                  <Pressable
                    key={c}
                    onPress={() => setCwdIndex(i)}
                    style={({ pressed }) => [
                      s.cwdChip,
                      i === cwdIndex ? s.cwdChipOn : pressed && s.rowPressed,
                    ]}
                  >
                    <Text style={[s.cwdLabel, i === cwdIndex && s.cwdLabelOn]}>
                      {c.split("/").pop() || c}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </ScrollView>
          ) : null}
        </View>
        {cwd ? (
          <ContextEditor
            // A new checkout is a new set of files; don't carry a draft across.
            key={cwd}
            hostId={space.hostId}
            cwd={cwd}
            project={space.name}
            repoId={space.repoId}
            files={files ?? []}
            loading={ctxLoading}
            unreachable={unreachable}
            onReload={() => void loadContext()}
            onSaved={onSaved}
          />
        ) : (
          <Text style={s.cardFoot}>
            No working directory known for this space yet — open one of its threads first.
          </Text>
        )}
      </View>
    </ScrollView>
  );
}

/**
 * What share of your work went into this project.
 *
 * Measured in TOKENS, deliberately, not dollars. Per-space cost is ledger-only,
 * so a share-of-spend figure would be a ratio between two differently
 * incomplete numbers. Tokens are complete for Claude and Codex and miss the
 * same agents on both sides of the ratio, so the percentage holds.
 */
function ShareOfWork({
  share,
  space,
  mine,
  total,
}: {
  share: number | null;
  space: Space;
  mine: number;
  total: number | null;
}) {
  // No denominator and no numerator are different failures, and neither is "0%
  // of your work" — a space whose threads recorded no agent turns has no share,
  // not a zero one.
  if (share == null) {
    return (
      <View>
        <Text style={s.cardTitle}>Share of your work</Text>
        <View style={s.shareRow}>
          <Text style={s.shareNil}>—</Text>
          <Text style={s.shareOf}>
            {total == null
              ? "can't compare — your other machines didn't answer"
              : mine > 0
                ? "nothing else to compare against yet"
                : "no agent turns recorded here in this window"}
          </Text>
        </View>
      </View>
    );
  }
  const pct = share * 100;
  return (
    <View>
      <Text style={s.cardTitle}>Share of your work</Text>
      <View style={s.shareRow}>
        <Text style={s.sharePct}>{pct < 1 ? "<1%" : `${Math.round(pct)}%`}</Text>
        <Text style={s.shareOf}>of your tokens in this window</Text>
      </View>
      {/* Two segments with a 2pt gap so they never read as one bar. */}
      <View style={s.shareTrack}>
        <View style={[s.shareMine, { flex: Math.max(0.004, share) }]} />
        <View style={[s.shareRest, { flex: Math.max(0.004, 1 - share) }]} />
      </View>
      <View style={s.shareKeys}>
        <View style={s.shareKey}>
          <View style={[s.shareSwatch, s.shareSwatchMine]} />
          <Text numberOfLines={1} style={s.shareKeyText}>
            {space.name} {fmtTokens(mine)}
          </Text>
        </View>
        <View style={s.shareKey}>
          <View style={[s.shareSwatch, s.shareSwatchRest]} />
          <Text numberOfLines={1} style={s.shareKeyText}>
            Everything else {fmtTokens(Math.max(0, (total ?? 0) - mine))}
          </Text>
        </View>
      </View>
    </View>
  );
}

/** How this project actually gets worked — the replacement for streak and
 *  active-days tiles, which are habit metrics borrowed from the account view. */
function Cadence({
  series,
  run,
  space,
  loading,
}: {
  series: readonly ActivityDay[];
  run: { current: number; longest: number; active: number };
  space: Space;
  loading: boolean;
}) {
  const stats = useMemo(() => {
    const active = series.filter((d) => d.messages > 0);
    if (!active.length) return null;
    const sorted = [...active].sort((a, b) => a.messages - b.messages);
    const median = sorted[Math.floor(sorted.length / 2)];
    const peak = active.reduce((m, d) => (d.messages > m.messages ? d : m), active[0]);
    return { median: median.messages, peak };
  }, [series]);

  if (loading) return <Text style={s.cardFoot}>Reading this project&apos;s cadence…</Text>;

  return (
    <View>
      <Text style={s.cardTitle}>Cadence</Text>
      {stats ? (
        <>
          <CadenceLine
            figure={fmtCount(run.active)}
            label={`${run.active === 1 ? "day" : "days"} worked in the last 12 months`}
          />
          <CadenceLine figure={fmtCount(stats.median)} label="messages on a typical working day" />
          <CadenceLine
            figure={fmtCount(stats.peak.messages)}
            label={`messages on its busiest, ${fmtDayLabel(stats.peak.date)}`}
          />
        </>
      ) : (
        <CadenceLine figure="—" label="no agent turns recorded here yet" muted />
      )}
      <CadenceLine
        figure={timeAgo(space.lastActivityAt)}
        label="since anything last happened here"
      />
    </View>
  );
}

function CadenceLine({ figure, label, muted }: { figure: string; label: string; muted?: boolean }) {
  return (
    <View style={s.cadLine}>
      <Text style={[s.cadFigure, muted && s.cadFigureMuted]}>{figure}</Text>
      <Text numberOfLines={1} style={s.cadLabel}>
        {label}
      </Text>
    </View>
  );
}

function Metric({
  label,
  value,
  hint,
  icon,
}: {
  label: string;
  value: string;
  hint?: string | null;
  icon: IoniconName;
}) {
  const { theme } = useUnistyles();
  return (
    <View style={s.metric}>
      <View style={s.metricHead}>
        <PounceIcon name={icon} size={12} color={theme.colors.fgFaint} />
        <Text style={s.metricLabel}>{label}</Text>
      </View>
      <Text numberOfLines={1} style={s.metricValue}>
        {value}
      </Text>
      {hint ? <Text style={s.metricHint}>{hint}</Text> : null}
    </View>
  );
}

const s = StyleSheet.create((theme, rt) => ({
  /** Safe-area padding lives in the SHEET, not a hook: unistyles applies it
   *  natively, so a rotation or a keyboard no longer re-renders the screen to
   *  move some padding. */
  contentPad: { paddingTop: IS_DESKTOP ? 14 : 0, paddingBottom: rt.insets.bottom + 32 },
  root: { flex: 1, backgroundColor: theme.colors.bg },
  flex1: { flex: 1 },
  shrink: { flexShrink: 1 },
  pressed: { opacity: 0.6 },
  rowPressed: { backgroundColor: theme.colors.surface },

  gone: { flex: 1, alignItems: "center", justifyContent: "center", gap: 9, padding: 24 },
  goneTitle: { fontSize: 16, fontWeight: "600", color: theme.colors.fg },
  goneBody: {
    maxWidth: 360,
    textAlign: "center",
    fontSize: 13,
    lineHeight: 19,
    color: theme.colors.fgMuted,
  },

  // Desktop gets a capped, centred column — the same measure the Activity
  // screen uses. Edge to edge across a 1400pt window leaves the tiles a foot
  // apart.
  content: {
    gap: 12,
    paddingHorizontal: IS_DESKTOP ? 24 : 14,
    ...(IS_DESKTOP ? { maxWidth: 1120, width: "100%", alignSelf: "center" } : null),
  },
  header: { flexDirection: "row", alignItems: "flex-end", gap: 10 },
  /** The pair inside the native header bar — glyph spacing, not button spacing,
   *  and a right margin because iOS runs the bar to the screen edge. */
  headerActions: { flexDirection: "row", alignItems: "center", gap: 18, marginRight: 4 },
  title: { fontSize: IS_DESKTOP ? 22 : 26, fontWeight: "700", color: theme.colors.fg },
  subtitle: { marginTop: 2, fontSize: 12.5, color: theme.colors.fgMuted },
  headerBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  headerBtnLabel: { fontSize: 12, fontWeight: "500", color: theme.colors.fgMuted },
  path: { marginTop: -6, fontFamily: "JetBrainsMono", fontSize: 11, color: theme.colors.fgFaint },

  /* Full width, thirds. It used to hug its labels (`alignSelf: "flex-start"`
     with a 68pt minimum), which left it floating short of the cards below it
     and made "Year" a smaller target than "Month" for no reason. Stretched, it
     lines up with the content it filters and every period is the same size. */
  segment: {
    alignSelf: "stretch",
    flexDirection: "row",
    gap: 2,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: 2,
  },
  segmentItem: { flex: 1, alignItems: "center", borderRadius: 7, paddingVertical: 5 },
  segmentItemOn: { backgroundColor: theme.colors.accent },
  segmentLabel: { fontSize: 12.5, fontWeight: "600", color: theme.colors.fgMuted },
  segmentLabelOn: { color: theme.colors.onAccent },

  tiles: { flexDirection: "row", gap: 10 },
  metric: {
    flex: 1,
    gap: 3,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  metricHead: { flexDirection: "row", alignItems: "center", gap: 5 },
  metricLabel: {
    fontSize: 10,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.4,
    color: theme.colors.fgFaint,
  },
  metricValue: {
    fontFamily: "JetBrainsMono",
    fontSize: IS_DESKTOP ? 18 : 20,
    fontWeight: "600",
    color: theme.colors.fg,
  },
  metricHint: { fontSize: 10.5, color: theme.colors.fgFaint },

  note: { fontSize: 12, color: theme.colors.fgFaint },
  card: {
    gap: 9,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
    padding: 14,
  },
  cardTitle: {
    fontSize: 10.5,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    color: theme.colors.fgFaint,
  },
  cardFoot: { fontSize: 12, color: theme.colors.fgMuted },

  shareRow: { marginTop: 7, flexDirection: "row", alignItems: "baseline", gap: 8 },
  sharePct: {
    fontFamily: "JetBrainsMono",
    fontSize: 26,
    fontWeight: "600",
    color: theme.colors.accent,
  },
  shareNil: {
    fontFamily: "JetBrainsMono",
    fontSize: 26,
    fontWeight: "600",
    color: theme.colors.fgFaint,
  },
  shareOf: { flexShrink: 1, fontSize: 13, color: theme.colors.fgMuted },
  shareTrack: { marginTop: 9, flexDirection: "row", gap: 2, height: 12 },
  shareMine: { borderRadius: 3, backgroundColor: theme.colors.accent },
  shareRest: { borderRadius: 3, backgroundColor: theme.colors.surfaceHover },
  shareKeys: { marginTop: 7, flexDirection: "row", gap: 14 },
  shareKey: { flex: 1, flexDirection: "row", alignItems: "center", gap: 5 },
  shareSwatch: { height: 8, width: 8, borderRadius: 2 },
  shareSwatchMine: { backgroundColor: theme.colors.accent },
  shareSwatchRest: { backgroundColor: theme.colors.surfaceHover },
  shareKeyText: { flexShrink: 1, fontSize: 11.5, color: theme.colors.fgMuted },

  cadLine: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 9,
    borderBottomWidth: 1,
    borderColor: theme.colors.border,
    paddingVertical: 7,
  },
  cadFigure: {
    minWidth: 62,
    fontFamily: "JetBrainsMono",
    fontSize: 14.5,
    fontWeight: "600",
    color: theme.colors.fg,
  },
  cadFigureMuted: { color: theme.colors.fgFaint },
  cadLabel: { flexShrink: 1, fontSize: 13, color: theme.colors.fgMuted },

  agentRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  agentName: { flex: 1, fontSize: 13.5, color: theme.colors.fg },
  agentStat: { fontFamily: "JetBrainsMono", fontSize: 12, color: theme.colors.fgMuted },
  agentCost: {
    minWidth: 66,
    textAlign: "right",
    fontFamily: "JetBrainsMono",
    fontSize: 12,
    color: theme.colors.fg,
  },
  agentFaint: { minWidth: 66, textAlign: "right", fontSize: 11.5, color: theme.colors.fgFaint },

  waitRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: 8,
    marginHorizontal: -6,
    paddingHorizontal: 6,
    paddingVertical: 6,
  },
  waitTitle: { flex: 1, fontSize: 13.5, color: theme.colors.fg },
  waitTime: { fontSize: 11, color: theme.colors.fgFaint },

  contextHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  cwdScroll: { flexGrow: 0 },
  cwdRow: { flexDirection: "row", gap: 5 },
  cwdChip: { borderRadius: 7, paddingHorizontal: 9, paddingVertical: 4 },
  cwdChipOn: { backgroundColor: theme.colors.accentSoft },
  cwdLabel: { fontFamily: "JetBrainsMono", fontSize: 11, color: theme.colors.fgMuted },
  cwdLabelOn: { color: theme.colors.accent },
}));
