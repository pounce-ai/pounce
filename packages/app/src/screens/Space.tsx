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
import { Pressable, ScrollView, Text, View, type LayoutChangeEvent } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
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
import { MiniBarChart } from "../components/MiniBarChart";
import { ContextEditor } from "../components/ContextEditor";
import { PounceIcon } from "../ui/native/Icon";
import type { IoniconName } from "../ui/native/icon-map";
import { AgentLogo, AgentStatusIcon, IS_DESKTOP, timeAgo } from "../ui";
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

/** Taller than the phone default — this chart is the block's centrepiece. */
const CHART_HEIGHT = IS_DESKTOP ? 132 : 108;

const PERIODS: Period[] = ["week", "month", "year"];
const PERIOD_LABEL: Record<Period, string> = { week: "Week", month: "Month", year: "Year" };

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
  const insets = useSafeAreaInsets();
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
  const bars = useMemo(() => {
    if (period !== "year") return window.map((d) => ({ key: d.date, value: d.messages }));
    const byMonth = new Map<string, number>();
    for (const d of series) {
      const k = d.date.slice(0, 7);
      byMonth.set(k, (byMonth.get(k) ?? 0) + d.messages);
    }
    return [...byMonth].map(([key, value]) => ({ key, value }));
  }, [period, window, series]);
  const detailDay = useMemo(
    () => (day ? (series.find((d) => d.date === day) ?? null) : null),
    [day, series],
  );

  const attention = sessions.filter(needsYou);

  return (
    <ScrollView
      style={s.root}
      contentContainerStyle={[
        s.content,
        { paddingTop: IS_DESKTOP ? 14 : insets.top + 8, paddingBottom: insets.bottom + 32 },
      ]}
    >
      <View style={s.header}>
        <View style={s.shrink}>
          <Text numberOfLines={1} style={s.title}>
            {space.name}
          </Text>
          <Text numberOfLines={1} style={s.subtitle}>
            {space.host} · {space.sessionCount} {space.sessionCount === 1 ? "thread" : "threads"} ·{" "}
            {space.liveCount} live · {`active ${timeAgo(space.lastActivityAt)}`}
          </Text>
        </View>
        <View style={s.flex1} />
        <Pressable
          onPress={() =>
            router.push({
              pathname: "/new",
              params: cwd
                ? { cwd, hostId: space.hostId, repoId: space.repoId }
                : { repoId: space.repoId },
            })
          }
          style={({ pressed }) => [s.headerBtn, pressed && s.pressed]}
        >
          <PounceIcon name="add-circle" size={14} color={theme.colors.fgMuted} />
          <Text style={s.headerBtnLabel}>New task</Text>
        </Pressable>
      </View>

      {cwd ? (
        <Text numberOfLines={1} style={s.path}>
          {cwd.replace(/^\/Users\/[^/]+/, "~")}
        </Text>
      ) : null}

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

      <View style={s.tiles}>
        <Metric label="Tokens" value={fmtTokens(now.tokens)} icon="sparkles" />
        <Metric label="Messages" value={fmtCount(now.messages)} icon="git-commit-outline" />
      </View>
      <View style={s.tiles}>
        <Metric label="Threads started" value={fmtCount(now.sessions)} icon="chatbubbles-outline" />
        <Metric
          label="Reported spend"
          value={now.cost == null ? "—" : `${now.costEstimated ? "~" : ""}${fmtCost(now.cost)}`}
          hint={now.cost == null ? "not reported" : now.costEstimated ? "list price" : null}
          icon="card-outline"
        />
      </View>

      {activityQ.isLoading ? (
        <Text style={s.note}>Reading this project&apos;s history…</Text>
      ) : activityQ.data == null ? (
        <Text style={s.note}>
          Couldn&apos;t read activity from {space.host}. The rest of this page still works.
        </Text>
      ) : null}

      {/* One block, three questions: WHEN the work happened, HOW MUCH OF YOU it
          took, and HOW it gets worked. */}
      <View
        style={s.card}
        onLayout={(e: LayoutChangeEvent) => setChartWidth(e.nativeEvent.layout.width - 28)}
      >
        <Text style={s.cardTitle}>
          {period === "year" ? "Messages by month" : `Messages · last ${PERIOD_DAYS[period]} days`}
        </Text>
        {chartWidth > 0 ? (
          <MiniBarChart
            bars={bars}
            width={chartWidth}
            height={CHART_HEIGHT}
            selected={period === "year" ? null : day}
            onSelect={period === "year" ? undefined : setDay}
          />
        ) : null}
        <Text numberOfLines={1} style={s.cardFoot}>
          {detailDay
            ? `${fmtDayLabel(detailDay.date)} — ${fmtCount(detailDay.messages)} messages · ${fmtTokens(detailDay.tokens)}`
            : period === "year"
              ? "A bar per month."
              : IS_DESKTOP
                ? "Click a day for its detail"
                : "Tap a day for its detail"}
        </Text>

        <View style={s.rule} />
        <ShareOfWork share={share} space={space} mine={now.tokens} total={allNow?.tokens ?? null} />

        <View style={s.rule} />
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

const s = StyleSheet.create((theme) => ({
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

  segment: {
    alignSelf: "flex-start",
    flexDirection: "row",
    gap: 2,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: 2,
  },
  segmentItem: { minWidth: 68, alignItems: "center", borderRadius: 7, paddingVertical: 5 },
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
  rule: { height: 1, backgroundColor: theme.colors.border, marginVertical: 3 },

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
