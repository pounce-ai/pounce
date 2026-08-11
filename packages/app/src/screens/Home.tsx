import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated as RNAnimated,
  Easing,
  Platform,
  Pressable,
  RefreshControl,
  Text,
  View,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { AnimatedLegendList } from "@legendapp/list/reanimated";
import { LinearTransition } from "react-native-reanimated";
import { useObservable, useSelector } from "@legendapp/state/react";
import { Stack, useRouter } from "expo-router";
import { PounceIcon } from "../ui/native/Icon";
import type { IoniconName } from "../ui/native/icon-map";
import type { Session } from "@pounce/shared";
import {
  activeFilterCount,
  applyFilters,
  connection$,
  needsYou,
  rankSession,
  deviceEmoji,
  deviceLabel,
  filters$,
  isFavRepo,
  isFavThread,
  showBucket,
  toggleFavRepo,
  toggleFavThread,
} from "../state/stores";
import {
  useDeviceOverrides,
  useDevicesById,
  useFavRepoSet,
  useFavThreadSet,
  useIgnoredSet,
  useProjects,
  useThreads,
} from "../state/db/hooks";
import { spaceKeyOf } from "../state/spaces";
import { canSettle, isSettled, partitionSettled } from "../state/settled";
import { autoSettleDays$, settled$, settleOptions, toggleSettled } from "../state/settledStore";
import { type Draft, draftTitle, drafts$, listDrafts, removeDraft } from "../state/drafts";
import { ScreenRoot } from "../components/ScreenRoot";
import { SessionCard } from "../components/SessionCard";
import { LiveStrip } from "../components/LiveStrip";
import { ConnectFlow } from "../components/ConnectFlow";
import { SessionListSkeleton } from "../components/Skeleton";
import { TabHeaderIcon } from "../components/TabHeaderIcon";
import { FilterButton, FilterSheet } from "../components/FilterSheet";
import { DeviceIcon, IS_DESKTOP, pickSheet } from "../ui";
import { refreshLive } from "../services/runtime";

/** Collapse key for the Favourites pseudo-group (shares the collapsed$ map). */
const FAV_KEY = "__fav__";
/** The same, for the Drafts shelf. Distinct from any repoId, which is why it
 *  carries the dunder shape. */
const DRAFTS_KEY = "__drafts__";

/** List props that never depend on render state — hoisted so the list doesn't
 *  see a new reference (and re-render every realised cell) on each commit. */
/** Plain object, NOT a unistyles entry: reanimated's AnimatedComponent resolves
 *  a `StyleSheet.create` proxy to `{}` here and throws "empty object is not a
 *  valid style value". */
const FILL = { flex: 1 } as const;
const LIST_HEADER = <LiveStrip />;
const rowKey = (r: Row) => {
  switch (r.type) {
    case "favHeader":
      return "favh";
    case "draftHeader":
      return "drafth";
    case "header":
      return `h:${r.repoId}`;
    case "draft":
      return `d:${r.draft.id}`;
    default:
      return `${r.fav ? "fav:" : ""}${r.session.id}`;
  }
};
const rowType = (r: Row) => r.type;

/** A shelf header (favourites, drafts), a directory header, or one row beneath
 *  any of them.
 *
 *  When every session in a directory lives on one device, the header carries that
 *  device's name/emoji so it can show the device glyph instead of a generic folder.
 *
 *  There is no settled row type: the archive is a VIEW (the Settled filter), and
 *  in it a settled thread is an ordinary session card grouped under its folder
 *  like any other. It earns no special row because, once you have asked to see
 *  it, it is just a thread. */
type Row =
  | { type: "favHeader"; count: number; collapsed: boolean }
  | { type: "draftHeader"; count: number; collapsed: boolean }
  | {
      type: "header";
      repoId: string;
      /** `repoId hostId` for the group's newest session — the Space this folder
       *  opens as. A folder can span machines; the one you touched last is the
       *  one you mean. */
      spaceKey: string;
      name: string;
      count: number;
      attention: number;
      collapsed: boolean;
      fav: boolean;
      deviceName?: string;
      deviceEmoji?: string;
    }
  | { type: "session"; session: Session; fav?: boolean }
  | { type: "draft"; draft: Draft };

export default function HomeScreen() {
  const router = useRouter();
  const { theme } = useUnistyles();

  const [refreshing, setRefreshing] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const collapsed$ = useObservable<Record<string, boolean>>({});
  // Replace the whole map (not a mutate-in-place on one key) so `collapsed$.get()`
  // returns a NEW reference — otherwise `useSelector` below sees the same object
  // and the grouped `useMemo` (dep: collapsedMap) never rebuilds, so the accordion
  // won't collapse. See legend-state object-selector gotcha.
  const toggleGroup = useCallback(
    (repoId: string) => collapsed$.set((m) => ({ ...m, [repoId]: !m[repoId] })),
    [collapsed$],
  );

  const status = useSelector(() => connection$.status.get());
  const filterCount = useSelector(() => activeFilterCount());

  const connected = status === "connected";
  const loading = status === "connecting" || status === "reconnecting";

  // Reactive inputs from the react-db collections + the Legend filter singleton.
  // Derive a FRESH object inside the selector — `filters$.get()` returns the
  // same mutated reference on every change, so the rows useMemo below never
  // saw its `f` dependency change and the list silently stopped filtering
  // (see memory: legend-state object-selector gotcha).
  const f = useSelector(() => ({
    device: filters$.device.get(),
    agent: filters$.agent.get(),
    repos: filters$.repos.get(),
    statuses: filters$.statuses.get(),
    branchQuery: filters$.branchQuery.get(),
    favOnly: filters$.favOnly.get(),
    show: filters$.show.get(),
  }));
  const rawThreads = useThreads();
  const projectList = useProjects();
  const deviceMap = useDevicesById();
  const favT = useFavThreadSet();
  const favR = useFavRepoSet();
  const ignored = useIgnoredSet();
  useDeviceOverrides(); // subscribe so header glyphs refresh on rename/emoji
  // Same identity gotcha as `f` above: spread to a fresh object so the rows
  // memo re-runs when a folder is collapsed/expanded.
  const collapsedMap = useSelector(() => ({ ...collapsed$.get() }));
  // The inbox inputs, both with the same fresh-object treatment for the same
  // reason. `autoSettleDays$` is a scalar so it needs no spread — but it MUST be
  // read here rather than only inside settleOptions(), or changing the policy in
  // Settings wouldn't re-render this screen at all.
  const overrides = useSelector(() => ({ ...settled$.get() }));
  const autoSettleDays = useSelector(() => autoSettleDays$.get());
  const draftList = useSelector(() => listDrafts(drafts$.get()));
  /** Looking at the archive and nothing else — the one Show combination that
   *  changes what the screen IS rather than how much of it you see, so the
   *  header, the empty state and the Drafts shelf all key off it. */
  const archiveOnly = f.show.length === 1 && f.show[0] === "settled";

  // Grouped rows, memoized to a STABLE value that only recomputes when the data
  // that feeds it changes. An unrelated re-render (e.g. a connection-status flip)
  // doesn't touch these deps, so the row list keeps the same reference — the
  // LegendList (and any in-list tour spotlight) never churns. Most-recently
  // worked-upon threads/folders float to the top; attention rank breaks ties.
  const { rows, attention: attentionCount } = useMemo(() => {
    const repos = Object.fromEntries(projectList.map((r) => [r.id, r]));
    // applyFilters handles device + agent + selected folders + permanently
    // ignored folders; the Show buckets are applied below.
    let list = applyFilters(rawThreads, {
      filters: f,
      ignored,
      repoName: (id) => repos[id]?.name ?? "",
    });
    // Settledness is resolved for the WHOLE list in one pass, against one clock,
    // before anything is dropped — `partitionSettled` owns the rule, including
    // that busy or blocked work is never treated as settled whatever the user
    // filed earlier, so nothing waiting on you can hide in the archive.
    const { settled } = partitionSettled(list, overrides, {
      now: new Date().toISOString(),
      autoSettleAfterDays: autoSettleDays,
    });
    const settledIds = new Set(settled.map((s) => s.id));
    // Counted over the FULL list, before the Show buckets narrow it: this drives
    // the "N need you" header, which is a standing fact about your work and not
    // a description of the current view. Turning the Needs-you bucket off should
    // not make the count claim nothing needs you.
    const attention = list.filter((s) => !settledIds.has(s.id) && needsYou(s)).length;
    // One membership test, because the buckets are disjoint — a thread is in
    // exactly one, so this can never double-count or drop a thread by accident.
    list = list.filter((s) => f.show.includes(showBucket(s, settledIds.has(s.id))));
    // Parse each updatedAt once; the thread sort and the per-folder "latest
    // activity" key both reuse it instead of re-parsing inside comparators.
    const tsOf = new Map(list.map((s) => [s.id, Date.parse(s.updatedAt)]));
    // Most-recently worked-upon first; attention rank only breaks exact-timestamp
    // ties. `partitionSettled` already ordered the archive by when it was
    // cleared, but re-sorting here keeps one comparator for both views — and in
    // the archive the two orders agree, since clearing a thread IS the last
    // thing that happened to it.
    const sorted = [...list].sort(
      (a, b) => tsOf.get(b.id)! - tsOf.get(a.id)! || rankSession(a) - rankSession(b),
    );

    const rows: Row[] = [];

    // Parked tasks, above everything: a draft is the newest thing you touched
    // and the one thing here that nothing else will remind you about. Not in
    // the archive, though — a draft has never run, so it is the opposite of
    // finished work rather than a quiet corner of it.
    if (draftList.length && !archiveOnly) {
      const draftsCollapsed = !!collapsedMap[DRAFTS_KEY];
      rows.push({ type: "draftHeader", count: draftList.length, collapsed: draftsCollapsed });
      if (!draftsCollapsed) for (const d of draftList) rows.push({ type: "draft", draft: d });
    }

    // Pinned "Favourites" pseudo-group above the repo accordion.
    const favSessions = sorted.filter((s) => favT.has(s.id));
    if (favSessions.length) {
      const favCollapsed = !!collapsedMap[FAV_KEY];
      rows.push({ type: "favHeader", count: favSessions.length, collapsed: favCollapsed });
      if (!favCollapsed)
        for (const s of favSessions) rows.push({ type: "session", session: s, fav: true });
    }

    const groups = new Map<string, Session[]>();
    for (const s of sorted) {
      const arr = groups.get(s.repoId);
      if (arr) arr.push(s);
      else groups.set(s.repoId, [s]);
    }
    // Decorate each folder once, then sort on the precomputed keys: favourites
    // pinned, then most-recent activity (glist[0] is newest since groups keep
    // sorted order), then attention rank as the tie-breaker.
    const ordered = [...groups.entries()]
      .map(([repoId, glist]) => ({
        repoId,
        glist,
        fav: favR.has(repoId) ? 0 : 1,
        latest: tsOf.get(glist[0].id)!,
        minRank: Math.min(...glist.map(rankSession)),
      }))
      .sort((a, b) => a.fav - b.fav || b.latest - a.latest || a.minRank - b.minRank);
    for (const { repoId, glist } of ordered) {
      const isCollapsed = !!collapsedMap[repoId];
      const hostIds = new Set(glist.map((s) => s.hostId));
      const dev = hostIds.size === 1 ? deviceMap[[...hostIds][0]!] : undefined;
      rows.push({
        type: "header",
        repoId,
        spaceKey: spaceKeyOf(glist[0]),
        name: repos[repoId]?.name ?? repoId.replace(/^repo:/, ""),
        count: glist.length,
        attention: glist.filter(needsYou).length,
        collapsed: isCollapsed,
        fav: favR.has(repoId),
        deviceName: dev ? deviceLabel(dev.id, dev.name) : undefined,
        deviceEmoji: dev ? deviceEmoji(dev.id) : undefined,
      });
      if (!isCollapsed) for (const s of glist) rows.push({ type: "session", session: s });
    }
    return { rows, attention };
  }, [
    rawThreads,
    projectList,
    deviceMap,
    favT,
    favR,
    ignored,
    f,
    collapsedMap,
    overrides,
    autoSettleDays,
    draftList,
    archiveOnly,
  ]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refreshLive(true);
    } finally {
      setRefreshing(false);
    }
  }, []);

  // Long-press a thread to favourite or settle it. New threads carry a temporary
  // id that's swapped for the real one after the first turn, so block
  // favouriting until then — a favourite keyed on the temp id would orphan.
  //
  // Built as a list rather than fixed positions because the settle entry is
  // CONDITIONAL: `canSettle` is false for anything running, queued or waiting on
  // the user, and offering a control that would spring straight back is worse
  // than not offering it. The handler indexes the same array, so the two can't
  // drift.
  const onLongPressSession = useCallback((s: Session) => {
    if (s.id.startsWith("new_")) return;
    const fav = isFavThread(s.id);
    const actions: { label: string; run: () => void }[] = [
      {
        label: fav ? "Remove from favourites" : "Add to favourites",
        run: () => toggleFavThread(s.id),
      },
    ];
    if (canSettle(s)) {
      const settled = isSettled(s, settled$[s.id].peek(), settleOptions());
      actions.push({
        label: settled ? "Move back to list" : "Settle",
        run: () => void toggleSettled(s),
      });
    }
    pickSheet(
      s.title,
      actions.map((a) => a.label),
      (i) => actions[i].run(),
    );
  }, []);

  /** A folder's insights — its spend, its cadence, its agent instructions.
   *  Reached from the chart button on the header row; also offered here, since
   *  the long-press sheet is where people look for what a row can do. */
  /** Carries the NAME as well as the key. The Space screen could look the name
   *  up itself, but the navigation bar's title has to be set by the navigator —
   *  a title pushed in from inside the screen is dropped from the large-title
   *  label whenever the navigator re-renders (it does on every appearance
   *  flip), leaving a blank header. In the route, it survives. */
  const openSpace = useCallback(
    (spaceKey: string, name: string) =>
      router.push({ pathname: "/space", params: { key: spaceKey, name } }),
    [router],
  );

  const onLongPressRepo = useCallback(
    (repoId: string, name: string, spaceKey: string) => {
      const fav = isFavRepo(repoId);
      pickSheet(
        name,
        // One word for this thing everywhere: a Space is a repo on a machine,
        // and the phone used to call the same object a folder or a project.
        [fav ? "Unfavourite space" : "Favourite space", "Open space"],
        (i) => {
          if (i === 0) toggleFavRepo(repoId);
          else if (i === 1) openSpace(spaceKey, name);
        },
      );
    },
    [openSpace],
  );

  const openDraft = useCallback(
    (id: string) => router.push({ pathname: "/new", params: { draft: id } }),
    [router],
  );

  const newInRepo = useCallback(
    (repoId: string) => router.push({ pathname: "/new", params: { repoId } }),
    [router],
  );

  // Every prop the list reads has to keep its reference across an unrelated
  // re-render (a sync tick, a connection blip) — a fresh `renderItem` alone
  // re-renders every realised cell. Profiled with argent 2026-08-06.
  const renderItem = useCallback(
    ({ item }: { item: Row }) => {
      switch (item.type) {
        case "favHeader":
          return (
            <FavHeader
              count={item.count}
              collapsed={item.collapsed}
              onPress={() => toggleGroup(FAV_KEY)}
            />
          );
        case "draftHeader":
          return (
            <ShelfHeader
              label="Drafts"
              icon="create-outline"
              count={item.count}
              collapsed={item.collapsed}
              onPress={() => toggleGroup(DRAFTS_KEY)}
            />
          );
        case "header":
          return (
            <DirHeader
              name={item.name}
              count={item.count}
              attention={item.attention}
              collapsed={item.collapsed}
              fav={item.fav}
              deviceName={item.deviceName}
              deviceEmoji={item.deviceEmoji}
              onPress={() => toggleGroup(item.repoId)}
              onAdd={() => newInRepo(item.repoId)}
              onOpen={() => openSpace(item.spaceKey, item.name)}
              onLongPress={() => onLongPressRepo(item.repoId, item.name, item.spaceKey)}
            />
          );
        case "draft":
          return (
            <DraftRow
              draft={item.draft}
              onPress={() => openDraft(item.draft.id)}
              onDiscard={() => removeDraft(item.draft.id)}
            />
          );
        default:
          return (
            <View style={s.sessionRow}>
              <SessionCard session={item.session} onLongPress={onLongPressSession} />
            </View>
          );
      }
    },
    [toggleGroup, newInRepo, openSpace, openDraft, onLongPressRepo, onLongPressSession],
  );
  const refreshControl = useMemo(
    () => (
      <RefreshControl
        refreshing={refreshing}
        onRefresh={onRefresh}
        tintColor={theme.colors.accent}
      />
    ),
    [refreshing, onRefresh, theme.colors.accent],
  );

  // Header subtitle, one branch per state; syncing lives in the wordmark
  // badge (spinner → green tick), so null here = nothing worth a row.
  const subtitle =
    !connected && !loading ? (
      <Text numberOfLines={1} style={s.subFaint}>
        Not connected yet
      </Text>
    ) : archiveOnly ? (
      /* Outranks the attention line, because in the archive that count would be
         describing threads this view is not showing. Says the view's name
         plainly: a list of old threads with no label is indistinguishable from
         a list that has gone wrong. */
      <Text numberOfLines={1} style={s.subFaint}>
        Settled threads
      </Text>
    ) : attentionCount > 0 ? (
      <>
        <PounceIcon name="alert-circle" size={13} color={theme.colors.warning} />
        <Text numberOfLines={1} style={s.subWarning}>
          {attentionCount} need{attentionCount === 1 ? "s" : ""} you
        </Text>
      </>
    ) : null;

  return (
    /**
     * A FRAGMENT on mobile, a View on desktop.
     *
     * iOS ties the large title to the screen's FIRST CHILD SCROLL VIEW — the
     * same rule SettingsScroll documents, and the reason Settings collapses
     * while this screen didn't. Wrapping the list in a View put a plain UIView
     * between the screen and its scroll view, so UIKit had nothing to track and
     * the title just sat there. A fragment adds no native view; the toolbars
     * below render configuration rather than UI, so the list is still the only
     * child. The background the wrapper used to paint comes from the stack's
     * `contentStyle` instead.
     */
    <ScreenRoot style={[s.root, s.rootPad]}>
      {/* The native bar's toolbar.
          iOS: one `Stack.Toolbar.Button` per action, so each gets its own glass
          capsule (a single `headerRight` would jam both into one).
          Android: ONE `Stack.Toolbar.View` holding our own controls. Its Compose
          host drops `Stack.Toolbar.Label` children and needs a real image source
          rather than an SF Symbol, so icon-and-label buttons render as empty tap
          targets there — the toolbar came up completely blank. A View lets the
          same FilterButton the desktop header uses do the job.

          Both are hidden with nothing paired, for the reason the inline pair
          was: a new task has nothing to run on, and a filter narrows a list
          that doesn't exist yet. Their absence leaves one thing on screen to
          do, where a greyed control would read as "this app is broken". */}
      {IS_DESKTOP || !connected ? null : (
        <Stack.Toolbar placement="right">
          {/* Each button a DIRECT child. `Stack.Toolbar` picks its items with
              React.Children.toArray(...).filter(isChildOfType(Button)), and
              toArray does not flatten fragments — wrapping the pair in a <>
              made the filter match nothing and the iOS toolbar vanish. */}
          {Platform.OS === "ios" && (
            <Stack.Toolbar.Button
              onPress={() => router.push("/filters")}
              accessibilityLabel="Filter"
            >
              {/* The FILLED variant when a filter is on — iOS's own way of
                    saying "this control is doing something". The badge can't
                    say it: that slot is spoken for by the attention count. */}
              <Stack.Toolbar.Icon
                sf={
                  filterCount > 0
                    ? "line.3.horizontal.decrease.circle.fill"
                    : "line.3.horizontal.decrease"
                }
              />
              {attentionCount > 0 ? (
                <Stack.Toolbar.Badge>{String(attentionCount)}</Stack.Toolbar.Badge>
              ) : null}
            </Stack.Toolbar.Button>
          )}
          {Platform.OS === "ios" && (
            <Stack.Toolbar.Button onPress={() => router.push("/new")} accessibilityLabel="New task">
              <Stack.Toolbar.Icon sf="square.and.pencil" />
            </Stack.Toolbar.Button>
          )}
          {Platform.OS !== "ios" && (
            <Stack.Toolbar.View>
              <View style={s.barActions}>
                <FilterButton active={false} onPress={() => router.push("/filters")} />
                <Pressable
                  onPress={() => router.push("/new")}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="New task"
                  style={({ pressed }) => pressed && s.pressed80}
                >
                  <PounceIcon name="create-outline" size={21} color={theme.colors.accent} />
                </Pressable>
              </View>
            </Stack.Toolbar.View>
          )}
        </Stack.Toolbar>
      )}
      {/* The tab's own glyph, leading the bar — with the spinner standing in
          while a sync runs. */}
      <TabHeaderIcon sf="house.fill" md="home" busy={loading} />

      {/* Desktop has no native bar, so it keeps drawing the glance header. */}
      {IS_DESKTOP ? (
        <View style={s.headerRow}>
          <View style={s.headerLeft}>
            <View style={s.wordmarkRow}>
              <Text style={s.wordmark}>Pounce</Text>
              {loading ? (
                <SyncSpinner />
              ) : connected && attentionCount === 0 ? (
                <PounceIcon
                  name="checkmark-circle"
                  size={12}
                  color={theme.colors.success}
                  style={{ marginTop: 5 }}
                />
              ) : null}
            </View>
            {subtitle || filterCount ? (
              <Pressable
                onPress={() => router.push(connected ? "/settings" : "/settings/devices")}
                style={({ pressed }) => [s.subtitleRow, pressed && s.pressed60]}
              >
                {subtitle}
                {filterCount > (archiveOnly ? 1 : 0) ? (
                  <Text style={s.subFaint}>· filtered</Text>
                ) : null}
              </Pressable>
            ) : null}
          </View>
          {connected ? (
            <View style={s.headerActions}>
              <FilterButton active={showFilters} onPress={() => setShowFilters(true)} />
              <Pressable
                onPress={() => router.push("/new")}
                style={({ pressed }) => [s.newBtn, pressed && s.pressed80]}
              >
                <PounceIcon name="add" size={17} color="#fff" />
                <Text style={s.newBtnLabel}>New</Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      ) : null}

      {IS_DESKTOP ? (
        <FilterSheet visible={showFilters} onClose={() => setShowFilters(false)} />
      ) : null}

      <AnimatedLegendList
        // Let UIKit inset the scroll under the translucent system tab bar —
        // without this the last rows hide beneath the bar.
        contentInsetAdjustmentBehavior="automatic"
        style={FILL}
        data={rows}
        // Subtle reorder: when a sync bumps a thread/folder's updatedAt and the
        // order changes, items ease to their new position instead of snapping.
        // NOTE: recycleItems must stay OFF with itemLayoutAnimation — a recycled
        // view animates from the previous item's position and can be left
        // mispositioned, which shows up as overlapping cards.
        // Built fresh per render ON PURPOSE: sharing one hoisted
        // LinearTransition instance across every animated row leaves a
        // just-reordered card mispositioned (it rides up into its group
        // header). The builder is cheap; the rest of the list's props are
        // the ones that had to be stabilised.
        itemLayoutAnimation={LinearTransition.duration(260)}
        keyExtractor={rowKey}
        renderItem={renderItem}
        estimatedItemSize={104}
        getItemType={rowType}
        keyboardDismissMode="on-drag"
        // Always render: recents come from persisted local state, so they must
        // survive being offline/mid-reconnect — the strip hides itself when
        // empty. Gating on `connected` made it vanish on every blip.
        ListHeaderComponent={LIST_HEADER}
        refreshControl={refreshControl}
        ListEmptyComponent={
          loading ? (
            <SessionListSkeleton />
          ) : !connected ? (
            <View style={s.empty}>
              {/* The desktop app ships the bridge and adopts it on launch, so
                  its only not-connected state is "that hasn't happened yet" —
                  which fixes itself. The phone is the one with setting up to
                  do, and ConnectFlow walks it from nothing to connected. */}
              <Text style={s.emptyTitle}>
                {IS_DESKTOP ? "Starting on this Mac…" : "Your agents, on your phone"}
              </Text>
              {IS_DESKTOP ? (
                <Text style={s.emptyBody}>Pounce runs the agent host here. Give it a moment.</Text>
              ) : (
                <ConnectFlow />
              )}
            </View>
          ) : archiveOnly ? (
            /* The archive's own empty state. "All caught up" here would be
               exactly backwards — an empty archive means nothing has been
               finished with yet, not that there is nothing left to do. */
            <View style={s.empty}>
              <Text style={s.emptyTitle}>Nothing settled yet</Text>
              <Text style={s.emptyBody}>
                Threads you settle — and ones that go quiet for a while — collect here.
              </Text>
            </View>
          ) : (
            <View style={s.empty}>
              <Text style={s.emptyTitle}>All caught up</Text>
              <Text style={s.emptyBody}>Nothing needs you right now.</Text>
            </View>
          )
        }
        // Bottom pad clears the system tab bar (the old floating dock needed
        // +120; the native bar insets the scroll view itself).
        contentContainerStyle={s.listPad}
      />
    </ScreenRoot>
  );
}

/** Pinned "Favourites" section header on the Home list. */
/** Rotating sync glyph — the wordmark badge's "working" state. Core Animated
 *  so it spins on desktop too (the reanimated seam is static there). */
function SyncSpinner() {
  const { theme } = useUnistyles();
  const turn = useRef(new RNAnimated.Value(0)).current;
  useEffect(() => {
    const loop = RNAnimated.loop(
      RNAnimated.timing(turn, {
        toValue: 1,
        duration: 900,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [turn]);
  const rotate = turn.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
  return (
    <RNAnimated.View style={{ marginTop: 5, transform: [{ rotate }] }}>
      <PounceIcon name="sync" size={12} color={theme.colors.fgFaint} />
    </RNAnimated.View>
  );
}

function FavHeader({
  count,
  collapsed,
  onPress,
}: {
  count: number;
  collapsed: boolean;
  onPress: () => void;
}) {
  const { theme } = useUnistyles();
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [s.groupHeader, pressed && s.pressed70]}>
      <PounceIcon
        name={collapsed ? "chevron-forward" : "chevron-down"}
        size={13}
        color={theme.colors.fgFaint}
      />
      <PounceIcon name="star" size={13} color={theme.colors.accent} />
      <Text style={s.groupTitle}>Favourites</Text>
      <Text style={s.groupCount}>{count}</Text>
    </Pressable>
  );
}

/** The two inbox shelves share a shape with FavHeader so the list reads as one
 *  set of sections rather than three different ideas of what a header is. */
function ShelfHeader({
  label,
  icon,
  count,
  collapsed,
  onPress,
}: {
  label: string;
  icon: IoniconName;
  count: number;
  collapsed: boolean;
  onPress: () => void;
}) {
  const { theme } = useUnistyles();
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [s.groupHeader, pressed && s.pressed70]}>
      <PounceIcon
        name={collapsed ? "chevron-forward" : "chevron-down"}
        size={13}
        color={theme.colors.fgFaint}
      />
      <PounceIcon name={icon} size={13} color={theme.colors.fgMuted} />
      <Text style={s.groupTitle}>{label}</Text>
      <Text style={s.groupCount}>{count}</Text>
    </Pressable>
  );
}

/** A parked task. Visibly unstarted — no agent chip, no status, no card — so it
 *  can't be mistaken for a thread an agent has actually run. */
function DraftRow({
  draft,
  onPress,
  onDiscard,
}: {
  draft: Draft;
  onPress: () => void;
  onDiscard: () => void;
}) {
  const { theme } = useUnistyles();
  const title = draftTitle(draft);
  return (
    // No leading pencil. The row sits under a "Drafts" header that already
    // carries one, and a per-row edit glyph reads as a BUTTON — something to
    // press to start editing — when the whole row is that button.
    <Pressable onPress={onPress} style={({ pressed }) => [s.shelfRow, pressed && s.pressed70]}>
      <Text numberOfLines={1} style={s.draftTitle}>
        {title}
      </Text>
      <Pressable
        onPress={onDiscard}
        hitSlop={10}
        accessibilityLabel={`Discard ${title}`}
        style={({ pressed }) => pressed && s.pressed70}
      >
        <PounceIcon name="close" size={16} color={theme.colors.fgFaint} />
      </Pressable>
    </Pressable>
  );
}

/** Collapsible directory section header on the Home list. The glyph shows the
 *  favourite star, else a single-device glyph, else a generic folder. */
function DirHeader({
  name,
  count,
  attention,
  collapsed,
  fav,
  deviceName,
  deviceEmoji: emoji,
  onPress,
  onAdd,
  onOpen,
  onLongPress,
}: {
  name: string;
  count: number;
  attention: number;
  collapsed: boolean;
  fav: boolean;
  deviceName?: string;
  deviceEmoji?: string;
  onPress: () => void;
  onAdd: () => void;
  onOpen: () => void;
  onLongPress: () => void;
}) {
  const { theme } = useUnistyles();
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={350}
      style={({ pressed }) => [s.groupHeader, pressed && s.pressed70]}
    >
      <PounceIcon
        name={collapsed ? "chevron-forward" : "chevron-down"}
        size={13}
        color={theme.colors.fgFaint}
      />
      {fav ? (
        <PounceIcon name="star" size={13} color={theme.colors.accent} />
      ) : deviceName ? (
        <DeviceIcon name={deviceName} emoji={emoji} color={theme.colors.fgFaint} size={13} />
      ) : (
        <PounceIcon name="folder-outline" size={13} color={theme.colors.fgFaint} />
      )}
      <Text numberOfLines={1} style={s.groupTitle}>
        {name}
      </Text>
      {attention > 0 ? (
        <View style={s.attentionBadge}>
          <Text style={s.attentionText}>{attention}</Text>
        </View>
      ) : null}
      <Text style={s.groupCount}>{count}</Text>
      {/* Nested Pressables with their own hit targets so these don't toggle the
          section. The eye opens the project's insights — its spend, its
          cadence, its agent instructions. It's a visible control rather than
          the long-press it used to be: tapping this row already means
          "collapse", so opening the project needs a target of its own, and a
          gesture nobody can see is a feature nobody finds. */}
      <Pressable
        onPress={onOpen}
        accessibilityLabel={`${name} insights`}
        hitSlop={8}
        style={({ pressed }) => [s.addBtn, pressed && s.pressed60]}
      >
        {/* An eye, not a bar chart: the chart glyph is the Activity TAB's icon,
            and repeating it on a row would promise the tab rather than this one
            folder. An eye reads as "look at this one". */}
        <PounceIcon name="eye-outline" size={16} color={theme.colors.fgMuted} />
      </Pressable>
      <Pressable
        onPress={onAdd}
        accessibilityLabel={`New task in ${name}`}
        hitSlop={8}
        style={({ pressed }) => [s.addBtn, pressed && s.pressed60]}
      >
        <PounceIcon name="add" size={17} color={theme.colors.fgMuted} />
      </Pressable>
    </Pressable>
  );
}

const s = StyleSheet.create((theme, rt) => ({
  /** Safe-area padding in the sheet — applied natively, no re-render. */
  listPad: { paddingTop: 6, paddingBottom: rt.insets.bottom + 16 },
  /** Desktop only — the mobile branch renders no view (see ScreenRoot). */
  rootPad: { paddingTop: rt.insets.top },
  root: { flex: 1, backgroundColor: theme.colors.bg },
  headerRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 8,
    paddingTop: 4,
  },
  headerLeft: { flex: 1, paddingRight: 8 },
  wordmarkRow: { flexDirection: "row", alignItems: "flex-start", gap: 4 },
  wordmark: { fontSize: 26, fontWeight: "700", color: theme.colors.fg },
  subtitleRow: { marginTop: 2, flexDirection: "row", alignItems: "center", gap: 4 },
  subFaint: { fontSize: 13, color: theme.colors.fgFaint },
  subWarning: { fontSize: 13, color: theme.colors.warning },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 0 },
  newBtn: {
    height: 36,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderRadius: 999,
    backgroundColor: theme.colors.accent,
    paddingHorizontal: 14,
  },
  newBtnLabel: { fontSize: 14, fontWeight: "600", color: theme.colors.onAccent },
  sessionRow: { paddingHorizontal: 16, paddingBottom: 10 },
  empty: { alignItems: "center", paddingHorizontal: 32, paddingVertical: 80 },
  emptyTitle: {
    marginBottom: 18,
    textAlign: "center",
    fontSize: 15,
    fontWeight: "600",
    color: theme.colors.fg,
  },
  emptyBody: { marginTop: 4, textAlign: "center", fontSize: 13, color: theme.colors.fgMuted },
  emptyCta: {
    marginTop: 20,
    borderRadius: 999,
    backgroundColor: theme.colors.accent,
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  groupHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 6,
    paddingTop: 12,
  },
  groupTitle: { flex: 1, fontSize: 13, fontWeight: "600", color: theme.colors.fgMuted },
  groupCount: { fontSize: 12, color: theme.colors.fgFaint },
  attentionBadge: {
    borderRadius: 999,
    backgroundColor: theme.colors.warningSoft,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  attentionText: { fontSize: 11, fontWeight: "600", color: theme.colors.warning },
  addBtn: { marginLeft: 2, height: 28, width: 28, alignItems: "center", justifyContent: "center" },
  /* A SHELF row — a draft. One line, no card, indented to start under its
     header's LABEL rather than at the gutter: 16 + chevron 13 + 8 + icon 13 + 8.
     Without the leading glyph the row used to carry, hugging the gutter put the
     title further left than the "Drafts" it belongs to, so the shelf read as
     two unrelated things stacked. */
  shelfRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingLeft: 58,
    paddingRight: 16,
    minHeight: 38,
  },
  draftTitle: { flex: 1, fontSize: 14, color: theme.colors.fgMuted },
  pressed60: { opacity: 0.6 },
  pressed70: { opacity: 0.7 },
  pressed80: { opacity: 0.8 },
  /** Android's toolbar slot — our own controls, since its Compose host can't
   *  render an SF Symbol or a bare label. */
  barActions: { flexDirection: "row", alignItems: "center", gap: 14, paddingRight: 4 },
}));
