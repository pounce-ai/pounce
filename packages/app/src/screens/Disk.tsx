/**
 * Disk — what the agents have left behind, and taking it back.
 *
 * Parallel agents work by cutting worktrees, and nothing cuts them back: the
 * bill arrives weeks later as a full disk, with no way to tell which of forty
 * directories anybody still needs. This page answers exactly that, in the order
 * you'd ask it — how much in total, who spent it, and then a list where each
 * row says what deleting it would cost you.
 *
 * The rule for the list: never let a row be deleted on the strength of its size
 * alone. Every row states its own risk first (uncommitted files, unpushed
 * commits, or neither) and the removal is refused by the HOST when work would
 * be lost — this screen turns that refusal into a choice, rather than a
 * warning it could have shown before the tap and an action it took anyway.
 */
import { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  View,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { type DiskReport, type WorktreeRow, fetchDisk, removeWorktree } from "../services/bridge";
import { useDevices } from "../state/db/hooks";
import { AgentLogo, IS_DESKTOP } from "../ui";
import { agentLabel } from "../ui/tokens";
import { fmtBytes, fmtCount } from "../ui/format";
import { PounceIcon } from "../ui/native/Icon";
import { ActivitySkeleton } from "../components/Skeleton";

/** Idle for this long with nothing uncommitted and nothing unpushed, and a
 *  worktree is almost certainly finished work. Ten days is deliberately past a
 *  sprint boundary — a week is still "last week's branch". */
const STALE_DAYS = 10;

/** A row nobody has to think about: nothing to lose, and long since idle. */
function isReclaimable(w: WorktreeRow): boolean {
  // Strict `=== 0`: an unknown dirty state is not a clean one.
  return w.dirtyFiles === 0 && !w.unpushed && (w.idleDays ?? 0) >= STALE_DAYS;
}

/**
 * The one sentence under a worktree's name — what you'd lose by deleting it.
 *
 * Ordered by severity rather than by recency, because the question this row
 * exists to answer is "can this go", and uncommitted work is the answer to
 * that whatever the dates say.
 */
function riskLine(w: WorktreeRow): string {
  const idle =
    w.idleDays == null
      ? "never used from Pounce"
      : w.idleDays === 0
        ? "used today"
        : `idle ${w.idleDays} ${w.idleDays === 1 ? "day" : "days"}`;
  if (w.dirtyFiles == null) return `${idle} · git records gone, contents unchecked`;
  if (w.dirtyFiles > 0) {
    return `${idle} · ${fmtCount(w.dirtyFiles)} uncommitted ${w.dirtyFiles === 1 ? "file" : "files"} would be lost`;
  }
  if (w.unpushed) {
    return `${idle} · ${w.unpushed} ${w.unpushed === 1 ? "commit" : "commits"} on no remote`;
  }
  if ((w.idleDays ?? 0) >= STALE_DAYS) return `${idle} · nothing uncommitted, safe to clear`;
  return `${idle} · nothing uncommitted`;
}

/** "3 days ago" for the scan stamp — a measurement has an age worth knowing. */
function ago(iso: string): string {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(mins) || mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export default function DiskScreen() {
  const { theme } = useUnistyles();
  const devices = useDevices();
  const router = useRouter();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["disk"],
    queryFn: () => fetchDisk(),
    // Sizing trees is expensive on the host and the answer barely moves, so
    // this deliberately doesn't re-measure on every visit. Pull-to-refresh is
    // how you say "go and look again".
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
  // Memoized rather than defaulted inline: `q.data ?? []` is a fresh array on
  // every render, which makes every derivation below re-run for identical data.
  const reports: DiskReport[] = useMemo(() => q.data ?? [], [q.data]);

  const remove = useMutation({
    mutationFn: (v: { hostId: string; path: string; force?: boolean; deleteBranch?: boolean }) =>
      removeWorktree(v.hostId, v.path, { force: v.force, deleteBranch: v.deleteBranch }),
    onSettled: () => {
      // The thread list names these directories too, so both views have to
      // re-read rather than keep describing a folder that no longer exists.
      void qc.invalidateQueries({ queryKey: ["disk"] });
      void qc.invalidateQueries({ queryKey: ["threads"] });
    },
  });

  const hostName = useCallback(
    (hostId: string) => devices.find((d) => d.id === hostId)?.name ?? "this machine",
    [devices],
  );

  const total = reports.reduce((n, r) => n + r.totalBytes, 0);
  const unmeasured = reports.reduce((n, r) => n + r.unmeasured, 0);
  const worktreeCount = reports.reduce((n, r) => n + r.worktrees.length, 0);

  /** Per-agent bytes folded across every machine — the graph. One agent's
   *  worktrees on two laptops are still that agent's disk. */
  const byAgent = useMemo(() => {
    const m = new Map<string, { agent: string | null; bytes: number; worktrees: number }>();
    for (const r of reports) {
      for (const a of r.agents) {
        const row = m.get(a.agent ?? "") ?? { agent: a.agent, bytes: 0, worktrees: 0 };
        row.bytes += a.bytes;
        row.worktrees += a.worktrees;
        m.set(a.agent ?? "", row);
      }
    }
    return [...m.values()].sort((x, y) => y.bytes - x.bytes);
  }, [reports]);

  /** Everything that could go right now, so the total at the top has a "…of
   *  which" worth acting on. */
  const reclaimable = useMemo(
    () =>
      reports.flatMap((r) =>
        r.worktrees.filter(isReclaimable).map((w) => ({ ...w, hostId: r.hostId })),
      ),
    [reports],
  );
  const reclaimableBytes = reclaimable.reduce((n, w) => n + (w.bytes ?? 0), 0);

  /**
   * Ask the host to remove it, and report what came back. Deliberately does no
   * prompting of its own: the two prompts below both end here, and a function
   * that both calls and is called by them is a cycle nobody can follow.
   */
  const runRemove = useCallback(
    async (w: WorktreeRow, opts: { force?: boolean; deleteBranch?: boolean }) => {
      setBusy(w.path);
      try {
        return await remove.mutateAsync({
          hostId: w.hostId,
          path: w.path,
          force: opts.force,
          deleteBranch: opts.deleteBranch,
        });
      } catch (e) {
        Alert.alert("Couldn't delete it", e instanceof Error ? e.message : String(e));
        return null;
      } finally {
        setBusy(null);
      }
    },
    [remove],
  );

  /** What the host said, as a sentence. Returns the `dirty` refusal to the
   *  caller, which is the only outcome with a follow-up question. */
  const report = useCallback((w: WorktreeRow, r: Awaited<ReturnType<typeof runRemove>>) => {
    if (!r) return null;
    if (r.ok) {
      Alert.alert(
        "Deleted",
        `${w.name} is gone${
          r.branchDeleted
            ? `, along with ${r.branch}.`
            : r.branch
              ? `. The branch ${r.branch} is still there.`
              : "."
        }`,
      );
      return null;
    }
    if (r.reason === "dirty") return r;
    Alert.alert(
      "Couldn't delete it",
      r.reason === "gone"
        ? "It's already gone from that machine."
        : r.reason === "unknown"
          ? "That machine no longer recognises this as a worktree."
          : "The machine couldn't remove the folder. Something may still have files open in it.",
    );
    return null;
  }, []);

  /**
   * Step 1: the branch question, asked every time.
   *
   * It's asked BEFORE the deletion rather than after because the two are one
   * decision — and because after the folder is gone, "also delete the branch?"
   * is a question about something the user can no longer look at.
   *
   * Step 2 only happens when there's work at stake: delete it anyway, or go and
   * finish it. "Open the last thread" is the whole reason the host refuses
   * rather than merely warning — the alternative to destroying the work is
   * usually to go back to the conversation that made it. The branch answer from
   * step 1 is carried through, so saying it twice is never asked of anyone.
   */
  const confirmDelete = useCallback(
    (w: WorktreeRow) => {
      const attempt = async (opts: { deleteBranch?: boolean }) => {
        const dirty = report(w, await runRemove(w, opts));
        if (!dirty) return;
        const buttons: Parameters<typeof Alert.alert>[2] = [{ text: "Cancel", style: "cancel" }];
        if (dirty.lastThreadId) {
          const id = dirty.lastThreadId;
          buttons.push({ text: "Open last thread", onPress: () => router.push(`/session/${id}`) });
        }
        buttons.push({
          text: "Delete anyway",
          style: "destructive",
          onPress: () => void runRemove(w, { ...opts, force: true }).then((r) => report(w, r)),
        });
        const n = dirty.dirtyFiles;
        Alert.alert(
          n == null ? `Pounce can't check ${w.name}` : `${w.name} has uncommitted work`,
          `${
            n == null
              ? "Git has no record of this worktree any more, so there's no way to tell whether anything in it is uncommitted. Deleting removes the folder as it stands."
              : `${fmtCount(n)} ${n === 1 ? "file has" : "files have"} changes that aren't committed anywhere. Deleting the worktree deletes them for good.`
          }${dirty.lastThreadId ? "\n\nYou can open the thread that made them instead." : ""}`,
          buttons,
        );
      };
      const size = w.bytes == null ? "" : ` and frees ${fmtBytes(w.bytes)}`;
      const branchNote = w.unpushed
        ? `\n\n${w.branch} has ${w.unpushed} ${w.unpushed === 1 ? "commit" : "commits"} that exist on no remote — deleting the branch loses ${w.unpushed === 1 ? "it" : "them"}.`
        : "";
      Alert.alert(
        `Delete ${w.name}?`,
        `This removes the folder on ${hostName(w.hostId)}${size}.${branchNote}`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: w.branch ? "Delete, keep branch" : "Delete",
            style: "destructive",
            onPress: () => void attempt({}),
          },
          // Android's Alert caps at three buttons, which is exactly what this
          // is — Cancel plus the two answers to the branch question.
          ...(w.branch
            ? [
                {
                  text: "Delete branch too",
                  style: "destructive" as const,
                  onPress: () => void attempt({ deleteBranch: true }),
                },
              ]
            : []),
        ],
      );
    },
    [runRemove, report, hostName, router],
  );

  return (
    <ScrollView
      style={s.root}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={s.content}
      refreshControl={
        <RefreshControl
          refreshing={q.isRefetching}
          onRefresh={() => {
            // "Go and look again" — the host re-measures every tree rather than
            // serving what it last worked out.
            void qc.fetchQuery({ queryKey: ["disk"], queryFn: () => fetchDisk({ fresh: true }) });
          }}
        />
      }
    >
      <View style={s.header}>
        {IS_DESKTOP ? <Text style={s.title}>Disk</Text> : null}
        <Text style={s.subtitle}>
          {worktreeCount === 0
            ? "worktrees your agents left behind"
            : `${fmtCount(worktreeCount)} ${worktreeCount === 1 ? "worktree" : "worktrees"} across ${reports.length} ${reports.length === 1 ? "machine" : "machines"}`}
          {reports[0] ? ` · measured ${ago(reports[0].scannedAt)}` : ""}
        </Text>
      </View>

      {q.isPending ? (
        <ActivitySkeleton />
      ) : q.isError ? (
        <View style={s.errorBox}>
          <Text style={s.errorTitle}>Couldn&apos;t measure the disk</Text>
          <Text style={s.errorBody}>
            No paired machine answered. Sizing a folder tree takes a while on a cold cache — if the
            machine is awake, give it a moment and pull to refresh.
          </Text>
        </View>
      ) : worktreeCount === 0 ? (
        <View style={s.errorBox}>
          <Text style={s.errorTitle}>Nothing to clear</Text>
          <Text style={s.errorBody}>
            No agent worktrees on any paired machine. This page counts worktrees only — the
            checkouts you work in yourself are yours, and are never listed here.
          </Text>
        </View>
      ) : (
        <>
          <View style={s.hero}>
            <Text style={s.heroValue}>{fmtBytes(total)}</Text>
            <View style={s.heroMeta}>
              <Text style={s.heroSub}>
                in agent worktrees
                {unmeasured > 0
                  ? ` · at least — ${unmeasured} ${unmeasured === 1 ? "folder" : "folders"} couldn't be measured`
                  : ""}
              </Text>
              {reclaimable.length ? (
                <Text style={s.heroGood}>
                  {fmtBytes(reclaimableBytes)} in {reclaimable.length}{" "}
                  {reclaimable.length === 1 ? "worktree" : "worktrees"} idle {STALE_DAYS}+ days with
                  nothing uncommitted
                </Text>
              ) : null}
            </View>
          </View>

          <View style={s.section}>
            <Text style={s.sectionTitle}>By agent</Text>
            <View style={s.card}>
              {byAgent.map((a) => (
                <View key={a.agent ?? "unclaimed"} style={s.row}>
                  <View style={s.rowHead}>
                    {a.agent ? <AgentLogo agent={a.agent} size={14} /> : null}
                    <Text numberOfLines={1} style={s.rowLabel}>
                      {/* Not "Unknown": these are worktrees no thread claims,
                          which is a fact about our records, not about them. */}
                      {a.agent ? agentLabel(a.agent) : "No thread claims these"}
                    </Text>
                    <Text style={s.rowValue}>{fmtBytes(a.bytes)}</Text>
                  </View>
                  <View style={s.track}>
                    <View
                      style={[
                        s.fill,
                        {
                          width: `${Math.max(1, Math.round((a.bytes / Math.max(total, 1)) * 100))}%`,
                        },
                      ]}
                    />
                  </View>
                  <Text style={s.rowSub}>
                    {a.worktrees} {a.worktrees === 1 ? "worktree" : "worktrees"}
                  </Text>
                </View>
              ))}
            </View>
          </View>

          {reports.map((r) => (
            <View key={r.hostId} style={s.section}>
              <Text style={s.sectionTitle}>
                {reports.length > 1 ? hostName(r.hostId) : "Worktrees"}
              </Text>
              <Text style={s.sectionNote}>
                Biggest first. Deleting removes the folder; the branch is kept unless you say
                otherwise.
              </Text>
              <View style={[s.card, s.wtCard]}>
                {r.worktrees.map((row, i) => {
                  const w = { ...row, hostId: r.hostId };
                  const working = busy === w.path;
                  const meta = `${w.repo ?? "unplaced"}${w.branch ? ` · ${w.branch}` : ""}${
                    w.threads ? ` · ${w.threads} ${w.threads === 1 ? "thread" : "threads"}` : ""
                  } · ${riskLine(w)}`;
                  // Built once, placed differently: a wide pane puts them at the
                  // end of the row, a phone under it. Quiet either way — a
                  // filled danger button on every row turned a list you're meant
                  // to read into twelve alarms, and the one row that IS
                  // dangerous stopped standing out. The weight belongs in the
                  // confirm dialog, which has it.
                  const actions = (
                    <View style={[s.wtActions, IS_DESKTOP && s.wtActionsLine]}>
                      {w.lastThreadId ? (
                        <Pressable
                          onPress={() => router.push(`/session/${w.lastThreadId}`)}
                          style={({ pressed }) => [s.btn, pressed && s.pressed]}
                        >
                          <Text style={s.btnLabel}>Open thread</Text>
                        </Pressable>
                      ) : null}
                      <Pressable
                        disabled={working}
                        onPress={() => confirmDelete(w)}
                        style={({ pressed }) => [s.btn, pressed && s.pressedDanger]}
                      >
                        {working ? (
                          <ActivityIndicator size="small" />
                        ) : (
                          <>
                            <PounceIcon
                              name="trash-outline"
                              size={12}
                              color={theme.colors.danger}
                            />
                            <Text style={s.btnDangerLabel}>Delete</Text>
                          </>
                        )}
                      </Pressable>
                    </View>
                  );
                  const logo = w.agent ? <AgentLogo agent={w.agent} size={13} /> : null;
                  const name = (
                    <Text numberOfLines={1} style={s.wtName}>
                      {w.name}
                    </Text>
                  );
                  const badge = isReclaimable(w) ? (
                    <Text style={s.badgeOk}>clearable</Text>
                  ) : w.dirtyFiles == null ? (
                    <Text style={s.badgeWarn}>unchecked</Text>
                  ) : w.dirtyFiles > 0 ? (
                    <Text style={s.badgeWarn}>uncommitted</Text>
                  ) : null;
                  const size = <Text style={s.wtSize}>{fmtBytes(w.bytes)}</Text>;

                  // Divided, not spaced. Twelve of these separated only by a gap
                  // read as one undifferentiated wall; a hairline is what makes
                  // each one a row you can rest your eye on.
                  //
                  // ONE line on a wide pane. Everything about a worktree fits
                  // across it — what it is, what it would cost, what you can do
                  // about it — and stacking those made a list of twelve into a
                  // page of twelve cards you had to scroll through.
                  return IS_DESKTOP ? (
                    <View key={w.path} style={[s.wtLine, i > 0 && s.wtDivided]}>
                      {logo}
                      {name}
                      {badge}
                      <Text numberOfLines={1} style={s.wtMetaInline}>
                        {meta}
                      </Text>
                      {size}
                      {actions}
                    </View>
                  ) : (
                    // A phone can't hold that across, and a touch target wants
                    // its own room: name and size, then the meta, then actions.
                    <View key={w.path} style={[s.wt, i > 0 && s.wtDivided]}>
                      <View style={s.wtHead}>
                        {logo}
                        {name}
                        {badge}
                        {size}
                      </View>
                      <Text style={s.wtMeta}>{meta}</Text>
                      {actions}
                    </View>
                  );
                })}
              </View>
            </View>
          ))}
        </>
      )}
    </ScrollView>
  );
}

const s = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.bg },
  content: { padding: 16, gap: 18, paddingBottom: 48 },
  header: { gap: 2 },
  title: { fontSize: 26, fontWeight: "700", color: theme.colors.fg },
  subtitle: { fontSize: 12.5, color: theme.colors.fgFaint },
  hero: { gap: 4 },
  heroValue: { fontFamily: "JetBrainsMono", fontSize: 36, color: theme.colors.fg },
  heroMeta: { gap: 2 },
  heroSub: { fontSize: 12.5, color: theme.colors.fgMuted },
  heroGood: { fontSize: 12.5, color: theme.colors.accent },
  section: { gap: 8 },
  sectionTitle: {
    fontSize: 11,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    color: theme.colors.fgFaint,
  },
  sectionNote: { fontSize: 11.5, color: theme.colors.fgFaint },
  card: {
    gap: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
    padding: 14,
  },
  /** The worktree list: rows are divided rather than spaced, and carry their
   *  own vertical padding, so the card contributes neither gap nor padding. */
  wtCard: { gap: 0, paddingVertical: 4 },
  row: { gap: 4 },
  rowHead: { flexDirection: "row", alignItems: "center", gap: 6 },
  rowLabel: { flex: 1, fontSize: 13, color: theme.colors.fg },
  rowValue: { fontFamily: "JetBrainsMono", fontSize: 12.5, color: theme.colors.fg },
  rowSub: { fontSize: 11, color: theme.colors.fgFaint },
  track: { height: 5, borderRadius: 999, backgroundColor: theme.colors.border, overflow: "hidden" },
  fill: { height: 5, borderRadius: 999, backgroundColor: theme.colors.accent },
  wt: { gap: 3, paddingVertical: 10 },
  /** The desktop row: one line, everything on it. `alignItems: center` so a
   *  badge, a monospace size and a button all sit on the same baseline band. */
  wtLine: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 7 },
  /** Takes the slack, so the size and the actions are pinned to the right edge
   *  and every row's actions line up in one column. */
  wtMetaInline: { flex: 1, fontSize: 11.5, color: theme.colors.fgFaint },
  /** Every row but the first. The card's own padding gives the first one its
   *  space, so a top border there would draw a line under the header. */
  wtDivided: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.border },
  wtHead: { flexDirection: "row", alignItems: "center", gap: 6 },
  wtName: { flexShrink: 1, fontSize: 13, fontWeight: "500", color: theme.colors.fg },
  wtSize: {
    marginLeft: "auto",
    // A column, not a value that happens to sit at the end of a sentence:
    // fixed width and right-aligned so "942 MB" and "4.3 GB" stack under each
    // other and the list can be read down rather than across.
    minWidth: 62,
    textAlign: "right",
    fontFamily: "JetBrainsMono",
    fontSize: 12.5,
    color: theme.colors.fg,
  },
  wtMeta: { fontSize: 11.5, lineHeight: 16, color: theme.colors.fgFaint },
  /** Right-aligned: the actions are the end of the row, not another sentence
   *  in it, and lining them up gives twelve rows one edge instead of twelve. */
  wtActions: { flexDirection: "row", justifyContent: "flex-end", gap: 6, marginTop: 2 },
  /** Reserves the width of BOTH buttons, so a worktree with no thread to open
   *  doesn't pull its Delete — and the size beside it — out of column. */
  wtActionsLine: { minWidth: 172, marginTop: 0 },
  badgeOk: {
    borderRadius: 999,
    backgroundColor: theme.colors.accentSoft,
    paddingHorizontal: 7,
    paddingVertical: 1,
    fontSize: 10,
    fontWeight: "600",
    color: theme.colors.accent,
  },
  badgeWarn: {
    borderRadius: 999,
    backgroundColor: theme.colors.warningSoft,
    paddingHorizontal: 7,
    paddingVertical: 1,
    fontSize: 10,
    fontWeight: "600",
    color: theme.colors.warning,
  },
  /** Ghost, both of them. See the note at the call site: a filled danger button
   *  repeated down the list is noise, and it drowns the row that deserves it. */
  btn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderRadius: 7,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  btnLabel: { fontSize: 11.5, color: theme.colors.fgMuted },
  btnDangerLabel: { fontSize: 11.5, fontWeight: "500", color: theme.colors.danger },
  pressed: { opacity: 0.7 },
  /** The colour arrives on press — the moment it becomes an action rather than
   *  a label. */
  pressedDanger: { backgroundColor: theme.colors.dangerSoft, borderColor: theme.colors.danger },
  errorBox: {
    gap: 6,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
    padding: 16,
  },
  errorTitle: { fontSize: 14, fontWeight: "600", color: theme.colors.fg },
  errorBody: { fontSize: 12.5, lineHeight: 18, color: theme.colors.fgMuted },
}));
