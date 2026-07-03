import { useState } from "react";
import { Pressable, RefreshControl, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LegendList } from "@legendapp/list/react-native";
import { useObservable, useSelector } from "@legendapp/state/react";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import type { Session } from "@litter/shared";
import {
  activeFilterCount,
  connection$,
  filters$,
  sessions$,
  repositories$,
} from "@/state/stores";
import { SessionCard } from "@/components/SessionCard";
import { SessionListSkeleton } from "@/components/Skeleton";
import { COLOR } from "@/ui";
import { refreshLive } from "@/services/runtime";

const needsYou = (s: Session) =>
  s.needsAttention || s.activity === "failed" || s.activity === "awaiting_input";

/** A directory header, or one session beneath it. */
type Row =
  | { type: "header"; repoId: string; name: string; count: number; attention: number; collapsed: boolean }
  | { type: "session"; session: Session };

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
    const collapsedMap = collapsed$.get();
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

    const groups = new Map<string, Session[]>();
    for (const s of sorted) {
      const arr = groups.get(s.repoId);
      if (arr) arr.push(s);
      else groups.set(s.repoId, [s]);
    }
    const ordered = [...groups.entries()].sort((a, b) => {
      const ra = Math.min(...a[1].map(rank));
      const rb = Math.min(...b[1].map(rank));
      if (ra !== rb) return ra - rb;
      const ta = Math.max(...a[1].map((s) => Date.parse(s.updatedAt)));
      const tb = Math.max(...b[1].map((s) => Date.parse(s.updatedAt)));
      return tb - ta;
    });
    const rows: Row[] = [];
    for (const [repoId, glist] of ordered) {
      const isCollapsed = !!collapsedMap[repoId];
      rows.push({
        type: "header",
        repoId,
        name: repos[repoId]?.name ?? repoId.replace(/^repo:/, ""),
        count: glist.length,
        attention: glist.filter(needsYou).length,
        collapsed: isCollapsed,
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
        <Pressable onPress={() => router.push("/new")} className="active:opacity-80 h-9 flex-row items-center gap-1 rounded-full bg-accent px-3.5 shrink-0">
          <Ionicons name="add" size={17} color="#fff" />
          <Text className="text-[14px] font-semibold text-white">New</Text>
        </Pressable>
      </View>

      <LegendList
        style={{ flex: 1 }}
        data={rows}
        keyExtractor={(r) => (r.type === "header" ? `h:${r.repoId}` : r.session.id)}
        renderItem={({ item }) =>
          item.type === "header" ? (
            <DirHeader
              name={item.name}
              count={item.count}
              attention={item.attention}
              collapsed={item.collapsed}
              onPress={() => toggleGroup(item.repoId)}
            />
          ) : (
            <View className="px-4 pb-2.5">
              <SessionCard session={item.session} />
            </View>
          )
        }
        estimatedItemSize={104}
        getItemType={(r) => r.type}
        recycleItems
        keyboardDismissMode="on-drag"
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

/** Collapsible directory section header on the Home list. */
function DirHeader({
  name,
  count,
  attention,
  collapsed,
  onPress,
}: {
  name: string;
  count: number;
  attention: number;
  collapsed: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      className="active:opacity-70 flex-row items-center gap-2 px-4 pb-1.5 pt-3"
    >
      <Ionicons name={collapsed ? "chevron-forward" : "chevron-down"} size={13} color={COLOR.fgFaint} />
      <Ionicons name="folder-outline" size={13} color={COLOR.fgFaint} />
      <Text numberOfLines={1} className="flex-1 text-[13px] font-semibold text-fg-muted">
        {name}
      </Text>
      {attention > 0 ? (
        <View className="rounded-full bg-warning/15 px-2 py-0.5">
          <Text className="text-[11px] font-semibold text-warning">{attention}</Text>
        </View>
      ) : null}
      <Text className="text-[12px] text-fg-faint">{count}</Text>
    </Pressable>
  );
}
