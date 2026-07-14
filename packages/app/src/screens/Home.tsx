import { useEffect, useMemo, useRef, useState } from "react";
import { ActionSheetIOS, Animated as RNAnimated, Easing, Modal, Pressable, RefreshControl, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AnimatedLegendList } from "@legendapp/list/reanimated";
import { LinearTransition } from "react-native-reanimated";
import { useObservable, useSelector } from "@legendapp/state/react";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import type { Session } from "@litter/shared";
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
import { SessionCard } from "../components/SessionCard";
import { RecentStrip } from "../components/RecentStrip";
import { SessionListSkeleton } from "../components/Skeleton";
import { FilterButton, FilterSheet } from "../components/FilterSheet";
import { cn, COLOR, DeviceIcon } from "../ui";
import { refreshLive } from "../services/runtime";

/** Collapse key for the Favourites pseudo-group (shares the collapsed$ map). */
const FAV_KEY = "__fav__";

/** A pinned favourites header, a directory header, or one session beneath either.
 *  When every session in a directory lives on one device, the header carries that
 *  device's name/emoji so it can show the device glyph instead of a generic folder. */
type Row =
  | { type: "favHeader"; count: number; collapsed: boolean }
  | {
      type: "header";
      repoId: string;
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

  const [refreshing, setRefreshing] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const collapsed$ = useObservable<Record<string, boolean>>({});
  // Replace the whole map (not a mutate-in-place on one key) so `collapsed$.get()`
  // returns a NEW reference — otherwise `useSelector` below sees the same object
  // and the grouped `useMemo` (dep: collapsedMap) never rebuilds, so the accordion
  // won't collapse. See legend-state object-selector gotcha.
  const toggleGroup = (repoId: string) =>
    collapsed$.set((m) => ({ ...m, [repoId]: !m[repoId] }));

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
      if (!favCollapsed) for (const s of favSessions) rows.push({ type: "session", session: s, fav: true });
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

  const onRefresh = async () => {
    setRefreshing(true);
    try { await refreshLive(true); } finally { setRefreshing(false); }
  };

  // Long-press a thread to favourite it. New threads carry a temporary id that's
  // swapped for the real one after the first turn, so block favouriting until
  // then — a favourite keyed on the temp id would orphan.
  const onLongPressSession = (s: Session) => {
    if (s.id.startsWith("new_")) return;
    const fav = isFavThread(s.id);
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: s.title,
        options: [fav ? "Remove from favourites" : "Add to favourites", "Cancel"],
        cancelButtonIndex: 1,
      },
      (i) => { if (i === 0) toggleFavThread(s.id); },
    );
  };

  const onLongPressRepo = (repoId: string, name: string) => {
    const fav = isFavRepo(repoId);
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: name,
        options: [fav ? "Unfavourite folder" : "Favourite folder", "Cancel"],
        cancelButtonIndex: 1,
      },
      (i) => { if (i === 0) toggleFavRepo(repoId); },
    );
  };

  const newInRepo = (repoId: string) => router.push({ pathname: "/new", params: { repoId } });

  // Header subtitle, one branch per state; syncing lives in the wordmark
  // badge (spinner → green tick), so null here = nothing worth a row.
  const subtitle =
    !connected && !loading ? (
      <Text numberOfLines={1} className="text-[13px] text-fg-faint">Tap to sync a device</Text>
    ) : attentionCount > 0 ? (
      <>
        <Ionicons name="alert-circle" size={13} color={COLOR.warning} />
        <Text numberOfLines={1} className="text-[13px] text-warning">
          {attentionCount} need{attentionCount === 1 ? "s" : ""} you
        </Text>
      </>
    ) : null;

  return (
    <View className="flex-1 bg-bg" style={{ paddingTop: insets.top }}>
      {/* Glance header */}
      <View className="flex-row items-end justify-between px-4 pb-2 pt-1">
        <View className="flex-1 pr-2">
          <View className="flex-row items-start gap-1">
            <Text className="text-[26px] font-bold text-fg">Pounce</Text>
            {/* Superscript status badge: spinner while syncing, then a green
                tick once connected and caught up. */}
            {loading ? (
              <SyncSpinner />
            ) : connected && attentionCount === 0 ? (
              <Ionicons name="checkmark-circle" size={12} color={COLOR.success} style={{ marginTop: 5 }} />
            ) : null}
          </View>
          {subtitle || filterCount ? (
            <Pressable
              onPress={() => router.push("/settings")}
              className="active:opacity-60 mt-0.5 flex-row items-center gap-1"
            >
              {subtitle}
              {filterCount ? <Text className="text-[13px] text-fg-faint">· filtered</Text> : null}
            </Pressable>
          ) : null}
        </View>
        <View className="flex-row items-center gap-2 shrink-0">
          <FilterButton active={showFilters} onPress={() => setShowFilters(true)} />
          <Pressable onPress={() => router.push("/new")} className="active:opacity-80 h-9 flex-row items-center gap-1 rounded-full bg-accent px-3.5">
            <Ionicons name="add" size={17} color="#fff" />
            <Text className="text-[14px] font-semibold text-white">New</Text>
          </Pressable>
        </View>
      </View>

      <FilterSheet visible={showFilters} onClose={() => setShowFilters(false)} />

      <AnimatedLegendList
        style={{ flex: 1 }}
        data={rows}
        // Subtle reorder: when a sync bumps a thread/folder's updatedAt and the
        // order changes, items ease to their new position instead of snapping.
        // NOTE: recycleItems must stay OFF with itemLayoutAnimation — a recycled
        // view animates from the previous item's position and can be left
        // mispositioned, which shows up as overlapping cards.
        itemLayoutAnimation={LinearTransition.duration(260)}
        keyExtractor={(r) =>
          r.type === "favHeader"
            ? "favh"
            : r.type === "header"
              ? `h:${r.repoId}`
              : `${r.fav ? "fav:" : ""}${r.session.id}`
        }
        renderItem={({ item }) =>
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
              onLongPress={() => onLongPressRepo(item.repoId, item.name)}
            />
          ) : (
            <View className="px-4 pb-2.5">
              <SessionCard session={item.session} onLongPress={onLongPressSession} />
            </View>
          )
        }
        estimatedItemSize={104}
        getItemType={(r) => r.type}
        keyboardDismissMode="on-drag"
        // Always render: recents come from persisted local state, so they must
        // survive being offline/mid-reconnect — the strip hides itself when
        // empty. Gating on `connected` made it vanish on every blip.
        ListHeaderComponent={<RecentStrip />}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={COLOR.accent} />}
        ListEmptyComponent={
          loading ? (
            <SessionListSkeleton />
          ) : !connected ? (
            <View className="items-center px-8 py-20">
              <Text className="text-[40px]">🐾</Text>
              <Text className="mt-3 text-center text-[15px] font-semibold text-fg">Connect your computer</Text>
              <Text className="mt-1 text-center text-[13px] text-fg-muted">
                Run Pounce Bridge on your Mac and scan the code to see your agents here.
              </Text>
              <Pressable
                onPress={() => router.push("/settings")}
                className="active:opacity-80 mt-5 rounded-full bg-accent px-5 py-2.5"
              >
                <Text className="text-[14px] font-semibold text-white">Sync a device</Text>
              </Pressable>
            </View>
          ) : (
            <View className="items-center px-8 py-20">
              <Text className="text-[40px]">🐾</Text>
              <Text className="mt-3 text-center text-[15px] font-semibold text-fg">All caught up</Text>
              <Text className="mt-1 text-center text-[13px] text-fg-muted">Nothing needs you right now.</Text>
            </View>
          )
        }
        contentContainerStyle={{ paddingTop: 6, paddingBottom: insets.bottom + 120 }}
      />
    </View>
  );
}

/** Pinned "Favourites" section header on the Home list. */
/** Rotating sync glyph — the wordmark badge's "working" state. Core Animated
 *  so it spins on desktop too (the reanimated seam is static there). */
function SyncSpinner() {
  const turn = useRef(new RNAnimated.Value(0)).current;
  useEffect(() => {
    const loop = RNAnimated.loop(
      RNAnimated.timing(turn, { toValue: 1, duration: 900, easing: Easing.linear, useNativeDriver: true }),
    );
    loop.start();
    return () => loop.stop();
  }, [turn]);
  const rotate = turn.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
  return (
    <RNAnimated.View style={{ marginTop: 5, transform: [{ rotate }] }}>
      <Ionicons name="sync" size={12} color={COLOR.fgFaint} />
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
  return (
    <Pressable
      onPress={onPress}
      className="active:opacity-70 flex-row items-center gap-2 px-4 pb-1.5 pt-3"
    >
      <Ionicons name={collapsed ? "chevron-forward" : "chevron-down"} size={13} color={COLOR.fgFaint} />
      <Ionicons name="star" size={13} color={COLOR.accent} />
      <Text className="flex-1 text-[13px] font-semibold text-fg-muted">Favourites</Text>
      <Text className="text-[12px] text-fg-faint">{count}</Text>
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
  onLongPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={350}
      className="active:opacity-70 flex-row items-center gap-2 px-4 pb-1.5 pt-3"
    >
      <Ionicons name={collapsed ? "chevron-forward" : "chevron-down"} size={13} color={COLOR.fgFaint} />
      {fav ? (
        <Ionicons name="star" size={13} color={COLOR.accent} />
      ) : deviceName ? (
        <DeviceIcon name={deviceName} emoji={emoji} color={COLOR.fgFaint} size={13} />
      ) : (
        <Ionicons name="folder-outline" size={13} color={COLOR.fgFaint} />
      )}
      <Text numberOfLines={1} className="flex-1 text-[13px] font-semibold text-fg-muted">
        {name}
      </Text>
      {attention > 0 ? (
        <View className="rounded-full bg-warning/15 px-2 py-0.5">
          <Text className="text-[11px] font-semibold text-warning">{attention}</Text>
        </View>
      ) : null}
      <Text className="text-[12px] text-fg-faint">{count}</Text>
      {/* Nested Pressable + its own hit target so tapping "+" starts a task in
          this folder instead of toggling the section. */}
      <Pressable
        onPress={onAdd}
        hitSlop={8}
        className="active:opacity-60 ml-0.5 h-7 w-7 items-center justify-center"
      >
        <Ionicons name="add" size={17} color={COLOR.fgMuted} />
      </Pressable>
    </Pressable>
  );
}
