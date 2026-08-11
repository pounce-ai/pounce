import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActionSheetIOS,
  Animated as RNAnimated,
  Easing,
  Pressable,
  RefreshControl,
  Text,
  View,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AnimatedLegendList } from "@legendapp/list/reanimated";
import { LinearTransition } from "react-native-reanimated";
import { useObservable, useSelector } from "@legendapp/state/react";
import { useRouter } from "expo-router";
import { PounceIcon } from "../ui/native/Icon";
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
import { SessionCard } from "../components/SessionCard";
import { LiveStrip } from "../components/LiveStrip";
import { ConnectFlow } from "../components/ConnectFlow";
import { SessionListSkeleton } from "../components/Skeleton";
import { FilterButton, FilterSheet } from "../components/FilterSheet";
import { DeviceIcon, IS_DESKTOP } from "../ui";
import { refreshLive } from "../services/runtime";

/** Collapse key for the Favourites pseudo-group (shares the collapsed$ map). */
const FAV_KEY = "__fav__";

/** List props that never depend on render state — hoisted so the list doesn't
 *  see a new reference (and re-render every realised cell) on each commit. */
/** Plain object, NOT a unistyles entry: reanimated's AnimatedComponent resolves
 *  a `StyleSheet.create` proxy to `{}` here and throws "empty object is not a
 *  valid style value". */
const FILL = { flex: 1 } as const;
const LIST_HEADER = <LiveStrip />;
const rowKey = (r: Row) =>
  r.type === "favHeader"
    ? "favh"
    : r.type === "header"
      ? `h:${r.repoId}`
      : `${r.fav ? "fav:" : ""}${r.session.id}`;
const rowType = (r: Row) => r.type;

/** A pinned favourites header, a directory header, or one session beneath either.
 *  When every session in a directory lives on one device, the header carries that
 *  device's name/emoji so it can show the device glyph instead of a generic folder. */
type Row =
  | { type: "favHeader"; count: number; collapsed: boolean }
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
  | { type: "session"; session: Session; fav?: boolean };

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
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
    needsOnly: filters$.needsOnly.get(),
    favOnly: filters$.favOnly.get(),
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

  // Grouped rows, memoized to a STABLE value that only recomputes when the data
  // that feeds it changes. An unrelated re-render (e.g. a connection-status flip)
  // doesn't touch these deps, so the row list keeps the same reference — the
  // LegendList (and any in-list tour spotlight) never churns. Most-recently
  // worked-upon threads/folders float to the top; attention rank breaks ties.
  const { rows, attention: attentionCount } = useMemo(() => {
    const repos = Object.fromEntries(projectList.map((r) => [r.id, r]));
    // applyFilters handles device + agent + selected folders + permanently
    // ignored folders; needsOnly is applied below with its smart default.
    let list = applyFilters(rawThreads, {
      filters: f,
      ignored,
      repoName: (id) => repos[id]?.name ?? "",
    });
    const attention = list.filter(needsYou).length;
    // Smart default: "needs you" narrows to attention items, but when nothing
    // needs you we show everything rather than an empty screen.
    if (f.needsOnly && attention > 0) list = list.filter(needsYou);
    // Parse each updatedAt once; the thread sort and the per-folder "latest
    // activity" key both reuse it instead of re-parsing inside comparators.
    const tsOf = new Map(list.map((s) => [s.id, Date.parse(s.updatedAt)]));
    // Most-recently worked-upon first; attention rank only breaks exact-timestamp ties.
    const sorted = [...list].sort(
      (a, b) => tsOf.get(b.id)! - tsOf.get(a.id)! || rankSession(a) - rankSession(b),
    );

    const rows: Row[] = [];

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
  }, [rawThreads, projectList, deviceMap, favT, favR, ignored, f, collapsedMap]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refreshLive(true);
    } finally {
      setRefreshing(false);
    }
  }, []);

  // Long-press a thread to favourite it. New threads carry a temporary id that's
  // swapped for the real one after the first turn, so block favouriting until
  // then — a favourite keyed on the temp id would orphan.
  const onLongPressSession = useCallback((s: Session) => {
    if (s.id.startsWith("new_")) return;
    const fav = isFavThread(s.id);
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: s.title,
        options: [fav ? "Remove from favourites" : "Add to favourites", "Cancel"],
        cancelButtonIndex: 1,
      },
      (i) => {
        if (i === 0) toggleFavThread(s.id);
      },
    );
  }, []);

  /** A folder's insights — its spend, its cadence, its agent instructions.
   *  Reached from the chart button on the header row; also offered here, since
   *  the long-press sheet is where people look for what a row can do. */
  const openSpace = useCallback(
    (spaceKey: string) => router.push({ pathname: "/space", params: { key: spaceKey } }),
    [router],
  );

  const onLongPressRepo = useCallback(
    (repoId: string, name: string, spaceKey: string) => {
      const fav = isFavRepo(repoId);
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title: name,
          // One word for this thing everywhere: a Space is a repo on a machine,
          // and the phone used to call the same object a folder or a project.
          options: [fav ? "Unfavourite space" : "Favourite space", "Open space", "Cancel"],
          cancelButtonIndex: 2,
        },
        (i) => {
          if (i === 0) toggleFavRepo(repoId);
          else if (i === 1) openSpace(spaceKey);
        },
      );
    },
    [openSpace],
  );

  const newInRepo = useCallback(
    (repoId: string) => router.push({ pathname: "/new", params: { repoId } }),
    [router],
  );

  // Every prop the list reads has to keep its reference across an unrelated
  // re-render (a sync tick, a connection blip) — a fresh `renderItem` alone
  // re-renders every realised cell. Profiled with argent 2026-08-06.
  const renderItem = useCallback(
    ({ item }: { item: Row }) =>
      item.type === "favHeader" ? (
        <FavHeader
          count={item.count}
          collapsed={item.collapsed}
          onPress={() => toggleGroup(FAV_KEY)}
        />
      ) : item.type === "header" ? (
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
          onOpen={() => openSpace(item.spaceKey)}
          onLongPress={() => onLongPressRepo(item.repoId, item.name, item.spaceKey)}
        />
      ) : (
        <View style={s.sessionRow}>
          <SessionCard session={item.session} onLongPress={onLongPressSession} />
        </View>
      ),
    [toggleGroup, newInRepo, openSpace, onLongPressRepo, onLongPressSession],
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
  const listContentStyle = useMemo(
    () => ({ paddingTop: 6, paddingBottom: insets.bottom + 16 }),
    [insets.bottom],
  );

  // Header subtitle, one branch per state; syncing lives in the wordmark
  // badge (spinner → green tick), so null here = nothing worth a row.
  const subtitle =
    !connected && !loading ? (
      <Text numberOfLines={1} style={s.subFaint}>
        Not connected yet
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
    <View style={[s.root, { paddingTop: insets.top }]}>
      {/* Glance header */}
      <View style={s.headerRow}>
        <View style={s.headerLeft}>
          <View style={s.wordmarkRow}>
            <Text style={s.wordmark}>Pounce</Text>
            {/* Superscript status badge: spinner while syncing, then a green
                tick once connected and caught up. */}
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
              {filterCount ? <Text style={s.subFaint}>· filtered</Text> : null}
            </Pressable>
          ) : null}
        </View>
        {/* Both actions need a machine: a new task has nothing to run on, and a
            filter narrows a list that doesn't exist yet. Hidden rather than
            disabled — a greyed control still reads as "this app is broken",
            while their absence leaves one thing on screen to do. They return
            the moment a device is connected. */}
        {connected ? (
          <View style={s.headerActions}>
            <FilterButton
              active={showFilters}
              onPress={() => (IS_DESKTOP ? setShowFilters(true) : router.push("/filters"))}
            />
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
          ) : (
            <View style={s.empty}>
              <Text style={s.emptyTitle}>All caught up</Text>
              <Text style={s.emptyBody}>Nothing needs you right now.</Text>
            </View>
          )
        }
        // Bottom pad clears the system tab bar (the old floating dock needed
        // +120; the native bar insets the scroll view itself).
        contentContainerStyle={listContentStyle}
      />
    </View>
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

const s = StyleSheet.create((theme) => ({
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
  pressed60: { opacity: 0.6 },
  pressed70: { opacity: 0.7 },
  pressed80: { opacity: 0.8 },
}));
