import { useState } from "react";
import { ActionSheetIOS, Modal, Pressable, RefreshControl, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LegendList } from "@legendapp/list/react-native";
import { useObservable, useSelector } from "@legendapp/state/react";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import type { Session } from "@litter/shared";
import {
  activeFilterCount,
  allAgentsInUse,
  allDevices,
  connection$,
  deviceEmoji,
  deviceLabel,
  deviceOverrides$,
  devices$,
  favRepos$,
  favThreads$,
  filters$,
  isFavRepo,
  isFavThread,
  sessions$,
  repositories$,
  toggleFavRepo,
  toggleFavThread,
} from "@/state/stores";
import { SessionCard } from "@/components/SessionCard";
import { RecentStrip } from "@/components/RecentStrip";
import { SessionListSkeleton } from "@/components/Skeleton";
import { agentLabel, cn, COLOR, DeviceIcon } from "@/ui";
import { refreshLive } from "@/services/runtime";

/** Collapse key for the Favourites pseudo-group (shares the collapsed$ map). */
const FAV_KEY = "__fav__";

const needsYou = (s: Session) =>
  s.needsAttention || s.activity === "failed" || s.activity === "awaiting_input";

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

/** Sort order: needs-you → running → other live → archived; newest within each. */
function rank(s: Session): number {
  if (needsYou(s)) return 0;
  if (s.activity === "running" || s.activity === "streaming") return 1;
  if (s.isLive) return 2;
  return 3;
}

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const [refreshing, setRefreshing] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const collapsed$ = useObservable<Record<string, boolean>>({});
  const toggleGroup = (repoId: string) => collapsed$[repoId].set((v) => !v);

  const status = useSelector(() => connection$.status.get());
  const filterCount = useSelector(() => activeFilterCount());

  const connected = status === "connected";
  const loading = status === "connecting" || status === "reconnecting";

  // Grouped rows as a legend-state computed: a STABLE value that only recomputes
  // when sessions / filters / collapse actually change. Because an unrelated
  // re-render (e.g. a connection-status flip) doesn't touch these, the row list
  // keeps the same reference — so the LegendList, and an in-list tour spotlight,
  // never churn. Directories needing attention float up; newest activity breaks ties.
  const view$ = useObservable(() => {
    const f = filters$.get();
    const repos = repositories$.get();
    const deviceMap = devices$.get();
    deviceOverrides$.get(); // track so header glyphs refresh on rename/emoji
    const collapsedMap = collapsed$.get();
    // Track the favourite maps so the view recomputes on toggle (selecting the
    // parent object alone wouldn't re-run — the Legend-State object gotcha).
    const favT = favThreads$.get();
    const favR = favRepos$.get();
    let list = Object.values(sessions$.get()).filter(
      (s) => (!f.device || s.hostId === f.device) && (!f.agent || s.agent === f.agent),
    );
    const attention = list.filter(needsYou).length;
    // Smart default: "needs you" narrows to attention items, but when nothing
    // needs you we show everything rather than an empty screen.
    if (f.needsOnly && attention > 0) list = list.filter(needsYou);
    const sorted = [...list].sort(
      (a, b) => rank(a) - rank(b) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
    );

    const rows: Row[] = [];

    // Pinned "Favourites" pseudo-group above the repo accordion.
    const favSessions = sorted.filter((s) => favT[s.id]);
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
    const ordered = [...groups.entries()].sort((a, b) => {
      // Favourited folders float to the top of the accordion region.
      const fa = favR[a[0]] ? 0 : 1;
      const fb = favR[b[0]] ? 0 : 1;
      if (fa !== fb) return fa - fb;
      const ra = Math.min(...a[1].map(rank));
      const rb = Math.min(...b[1].map(rank));
      if (ra !== rb) return ra - rb;
      const ta = Math.max(...a[1].map((s) => Date.parse(s.updatedAt)));
      const tb = Math.max(...b[1].map((s) => Date.parse(s.updatedAt)));
      return tb - ta;
    });
    for (const [repoId, glist] of ordered) {
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
        fav: !!favR[repoId],
        deviceName: dev ? deviceLabel(dev.id, dev.name) : undefined,
        deviceEmoji: dev ? deviceEmoji(dev.id) : undefined,
      });
      if (!isCollapsed) for (const s of glist) rows.push({ type: "session", session: s });
    }
    return { rows, attention };
  });
  const { rows, attention: attentionCount } = useSelector(view$);

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

  return (
    <View className="flex-1 bg-bg" style={{ paddingTop: insets.top }}>
      {/* Glance header */}
      <View className="flex-row items-end justify-between px-4 pb-2 pt-1">
        <View className="flex-1 pr-2">
          <Text className="text-[26px] font-bold text-fg">Pounce</Text>
          <Pressable onPress={() => router.push("/settings")} className="active:opacity-60">
            <Text numberOfLines={1} className="text-[13px] text-fg-faint">
              {!connected && !loading
                ? "Tap to sync a device"
                : loading
                  ? "Syncing…"
                  : attentionCount > 0
                    ? `${attentionCount} need${attentionCount === 1 ? "s" : ""} you`
                    : "All caught up"}
              {filterCount ? " · filtered" : ""}
            </Text>
          </Pressable>
        </View>
        <View className="flex-row items-center gap-2 shrink-0">
          <Pressable
            onPress={() => setShowFilters(true)}
            className={cn(
              "active:opacity-80 h-9 w-9 items-center justify-center rounded-full",
              showFilters || filterCount ? "bg-accent/15" : "bg-surface-alt",
            )}
          >
            <Ionicons
              name="filter"
              size={17}
              color={showFilters || filterCount ? COLOR.accent : COLOR.fgMuted}
            />
            {filterCount ? (
              <View className="absolute -right-0.5 -top-0.5 h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1">
                <Text className="text-[10px] font-bold text-white">{filterCount}</Text>
              </View>
            ) : null}
          </Pressable>
          <Pressable onPress={() => router.push("/new")} className="active:opacity-80 h-9 flex-row items-center gap-1 rounded-full bg-accent px-3.5">
            <Ionicons name="add" size={17} color="#fff" />
            <Text className="text-[14px] font-semibold text-white">New</Text>
          </Pressable>
        </View>
      </View>

      <HomeFilterSheet visible={showFilters} onClose={() => setShowFilters(false)} />

      <LegendList
        style={{ flex: 1 }}
        data={rows}
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
        recycleItems
        keyboardDismissMode="on-drag"
        ListHeaderComponent={connected ? <RecentStrip /> : null}
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

/** A pill filter toggle. */
function FilterChip({
  label,
  active,
  onPress,
  icon,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  icon?: React.ReactNode;
}) {
  return (
    <Pressable
      onPress={onPress}
      className={cn(
        "active:opacity-80 h-8 flex-row items-center gap-1.5 rounded-full border px-3",
        active ? "border-accent bg-accent/15" : "border-border bg-surface-alt",
      )}
    >
      {icon}
      <Text className={cn("text-[13px]", active ? "text-accent" : "text-fg")}>{label}</Text>
    </Pressable>
  );
}

/** Filter bottom sheet on Home — status · device · agent, mirroring the Search
 *  filter surface but reachable right where the list lives. Writes straight to
 *  the shared `filters$`, so Home and Search stay in lockstep. */
function HomeFilterSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const f = useSelector(() => filters$.get());
  const devices = useSelector(() => allDevices());
  const agents = useSelector(() => allAgentsInUse());
  useSelector(() => deviceOverrides$.get());
  const hasFilter = !!(f.agent || f.device || f.needsOnly);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable className="flex-1 bg-black/50" onPress={onClose} />
      <View
        style={{ paddingBottom: insets.bottom + 16 }}
        className="gap-4 rounded-t-3xl border-t border-border bg-bg-elevated px-4 pt-3"
      >
        <View className="h-1 w-10 self-center rounded-full bg-border" />
        <View className="flex-row items-center justify-between">
          <Text className="text-[18px] font-bold text-fg">Filter</Text>
          {hasFilter ? (
            <Pressable
              onPress={() => filters$.set({ device: null, agent: null, needsOnly: false, favOnly: false })}
              className="active:opacity-60 flex-row items-center gap-1.5"
            >
              <Ionicons name="close-circle-outline" size={15} color={COLOR.fgMuted} />
              <Text className="text-[13px] text-fg-muted">Clear all</Text>
            </Pressable>
          ) : null}
        </View>

        <View className="gap-1.5">
          <Text className="text-[11px] uppercase tracking-wide text-fg-faint">Show</Text>
          <View className="flex-row flex-wrap gap-2">
            <FilterChip label="Needs you" active={f.needsOnly} onPress={() => filters$.needsOnly.set(true)} />
            <FilterChip label="Everything" active={!f.needsOnly} onPress={() => filters$.needsOnly.set(false)} />
          </View>
        </View>

        {devices.length > 1 ? (
          <View className="gap-1.5">
            <Text className="text-[11px] uppercase tracking-wide text-fg-faint">Device</Text>
            <View className="flex-row flex-wrap gap-2">
              {devices.map((d) => (
                <FilterChip
                  key={d.id}
                  label={deviceLabel(d.id, d.name)}
                  active={f.device === d.id}
                  onPress={() => filters$.device.set(f.device === d.id ? null : d.id)}
                  icon={
                    <DeviceIcon
                      name={d.name}
                      emoji={deviceEmoji(d.id)}
                      color={f.device === d.id ? COLOR.accent : COLOR.fgMuted}
                      size={13}
                    />
                  }
                />
              ))}
            </View>
          </View>
        ) : null}

        {agents.length > 1 ? (
          <View className="gap-1.5">
            <Text className="text-[11px] uppercase tracking-wide text-fg-faint">Agent</Text>
            <View className="flex-row flex-wrap gap-2">
              {agents.map((a) => (
                <FilterChip
                  key={a}
                  label={agentLabel(a)}
                  active={f.agent === a}
                  onPress={() => filters$.agent.set(f.agent === a ? null : a)}
                />
              ))}
            </View>
          </View>
        ) : null}

        <Pressable
          onPress={onClose}
          className="active:opacity-90 mt-1 h-12 items-center justify-center rounded-xl bg-accent"
        >
          <Text className="text-[15px] font-semibold text-white">Done</Text>
        </Pressable>
      </View>
    </Modal>
  );
}
