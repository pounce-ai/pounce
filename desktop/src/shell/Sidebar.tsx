/**
 * Desktop sidebar: search + new task on top, threads grouped under collapsible
 * project (repo) sections, connection/status footer. Dense flat rows rather
 * than the mobile card list; the selected thread is highlighted and groups
 * needing attention float to the top (same ranking as mobile Home).
 */
import { useMemo, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { LegendList } from "@legendapp/list/react-native";
import { useSelector } from "@legendapp/state/react";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import type { Session } from "@pounce/shared";
import { applyFilters, connection$, filters$, needsYou } from "@pounce/app/state/stores";
import { useDevices, useIgnoredSet, useProjectNames, useThreads } from "@pounce/app/state/db/hooks";
import { SessionListSkeleton } from "@pounce/app/components/Skeleton";
import { LiveStrip } from "@pounce/app/components/LiveStrip";
import { FilterButton, FilterSheet } from "@pounce/app/components/FilterSheet";
import { AgentStatusIcon, cn, COLOR, INPUT_TWEAKS, timeAgo } from "@pounce/app/ui";
import { nav$ } from "../shims/router";

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

export function Sidebar() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  // Plain state, not a Legend observable: selecting a parent object returns
  // the same mutated reference, so toggles never re-render (the classic
  // object-selector gotcha) — and this is purely local UI state anyway.
  const [collapsedMap, setCollapsedMap] = useState<Record<string, boolean>>({});
  const toggleGroup = (repoId: string) =>
    setCollapsedMap((m) => ({ ...m, [repoId]: !m[repoId] }));

  const status = useSelector(() => connection$.status.get());
  const selectedId = useSelector(() => nav$.detail.get()?.params.id ?? null);
  // Derive a FRESH object reading each leaf — selecting the parent `filters$`
  // object returns the same mutated ref on a child change, so device/agent/repo
  // toggles wouldn't re-render (the Legend object-selector gotcha, same as Home).
  const f = useSelector(() => ({
    device: filters$.device.get(),
    agent: filters$.agent.get(),
    repos: filters$.repos.get(),
    needsOnly: filters$.needsOnly.get(),
    favOnly: filters$.favOnly.get(),
  }));
  const deviceList = useDevices();
  const threads = useThreads();
  const projectNames = useProjectNames();
  const ignored = useIgnoredSet();

  const connected = status === "connected";
  const loading = status === "connecting" || status === "reconnecting";

  const q = query.trim().toLowerCase();
  const { rows: allRows, attention } = useMemo(() => {
    // Identical filtering to mobile Home: device · agent · project (+ ignored/
    // dotfolder hiding) via the shared predicate, then the smart "needs you"
    // narrowing (only hides non-attention threads when something needs you).
    let list = applyFilters(threads, {
      filters: { device: f.device, agent: f.agent, repos: f.repos },
      ignored,
      repoName: (id) => projectNames[id] ?? id,
    });
    const attentionCount = list.filter(needsYou).length;
    if (f.needsOnly && attentionCount > 0) list = list.filter(needsYou);
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
        name: projectNames[repoId] ?? repoId.replace(/^repo:/, ""),
        count: glist.length,
        attention: glist.filter(needsYou).length,
        collapsed: isCollapsed,
      });
      if (!isCollapsed) for (const s of glist) rows.push({ type: "session", session: s });
    }
    return { rows, attention: attentionCount };
  }, [threads, projectNames, ignored, f, collapsedMap]);

  return (
    <View className="flex-1 bg-bg-elevated">
      {/* Top bar: search + new */}
      <View className="flex-row items-center gap-2 px-3 pb-2 pt-3">
        <View className="h-8 flex-1 flex-row items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5">
          <Ionicons name="search" size={13} color={COLOR.fgFaint} />
          <TextInput {...INPUT_TWEAKS}
            value={query}
            onChangeText={setQuery}
            placeholder="Search threads"
            placeholderTextColor={COLOR.fgFaint}
            className="flex-1 text-[13px] text-fg"
            style={{ paddingVertical: 0 }}
          />
          {query ? (
            <Pressable onPress={() => setQuery("")} className="active:opacity-60">
              <Ionicons name="close-circle" size={14} color={COLOR.fgFaint} />
            </Pressable>
          ) : null}
        </View>
        <FilterButton active={showFilters} onPress={() => setShowFilters(true)} />
        <Pressable
          onPress={() => router.push("/new")}
          className="active:opacity-80 h-8 w-8 items-center justify-center rounded-lg bg-accent"
        >
          <Ionicons name="add" size={18} color="#fff" />
        </Pressable>
      </View>

      {attention > 0 ? (
        <View className="mx-3 mb-1 flex-row items-center gap-1.5 rounded-md bg-warning/10 px-2 py-1">
          <Ionicons name="alert-circle" size={12} color={COLOR.fgMuted} />
          <Text className="text-[11px] font-medium text-warning">
            {attention} thread{attention === 1 ? "" : "s"} need{attention === 1 ? "s" : ""} you
          </Text>
        </View>
      ) : null}

      {/* Live — sessions working right now, or the most recently active as a
          fallback (hides when empty or while searching). */}
      {!q ? <LiveStrip /> : null}

      <LegendList
        style={{ flex: 1 }}
        data={filterRows(allRows, q)}
        keyExtractor={(r) => (r.type === "header" ? `h:${r.repoId}` : r.session.id)}
        renderItem={({ item }) =>
          item.type === "header" ? (
            <GroupHeader row={item} onPress={() => toggleGroup(item.repoId)} />
          ) : (
            <ThreadRow
              session={item.session}
              selected={item.session.id === selectedId}
              onPress={() => router.push(`/session/${item.session.id}`)}
            />
          )
        }
        estimatedItemSize={44}
        getItemType={(r) => r.type}
        recycleItems
        ListEmptyComponent={
          loading ? (
            <SessionListSkeleton count={6} />
          ) : !connected ? (
            <View className="items-center px-6 py-16">
              <Text className="text-[28px]">🐾</Text>
              <Text className="mt-2 text-center text-[13px] font-semibold text-fg">Starting up…</Text>
              <Text className="mt-1 text-center text-[12px] text-fg-muted">
                The agent host on this Mac is warming up. Threads appear here automatically.
              </Text>
            </View>
          ) : q ? (
            <View className="items-center px-6 py-16">
              <Text className="text-center text-[12px] text-fg-muted">No threads match “{query}”.</Text>
            </View>
          ) : (
            <View className="items-center px-6 py-16">
              <Text className="text-[28px]">🐾</Text>
              <Text className="mt-2 text-center text-[13px] font-semibold text-fg">No threads yet</Text>
              <Text className="mt-1 text-center text-[12px] leading-[17px] text-fg-muted">
                Start a task with the + button, or run an agent in a repo on this Mac.
              </Text>
              <Pressable
                onPress={() => router.push("/diagnostics")}
                className="active:opacity-70 mt-3 flex-row items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-2"
              >
                <Ionicons name="medkit-outline" size={13} color={COLOR.fgMuted} />
                <Text className="text-[12px] font-medium text-fg-muted">Check setup</Text>
              </Pressable>
            </View>
          )
        }
        contentContainerStyle={{ paddingBottom: 12 }}
      />

      {/* Footer: connection + utilities */}
      <View className="flex-row items-center gap-1 border-t border-border px-3 py-2">
        <View className="flex-1 flex-row items-center gap-1.5">
          <View className={cn("h-2 w-2 rounded-full", connected ? "bg-success" : loading ? "bg-warning" : "bg-fg-faint")} />
          <Text numberOfLines={1} className="text-[11px] text-fg-muted">
            {connected
              ? deviceList.filter((d) => d.online).map((d) => d.name).join(", ") || "Connected"
              : loading
                ? "Connecting…"
                : "Offline"}
          </Text>
        </View>
        <FooterIcon name="qr-code-outline" hint="Pair phone" onPress={() => router.push("/pair")} />
        <FooterIcon name="time-outline" hint="Sync history" onPress={() => router.push("/sync-history")} />
        <FooterIcon name="help-circle-outline" hint="Help" onPress={() => router.push("/help")} />
        <FooterIcon name="settings-outline" hint="Settings" onPress={() => router.push("/settings")} />
      </View>

      {/* Same filter sheet as mobile (Home/Search) — 1:1 controls via the shared
          component; renders as an in-window overlay through AppModal.desktop. */}
      <FilterSheet visible={showFilters} onClose={() => setShowFilters(false)} />
    </View>
  );
}

/** Flatten + filter rows for search: matching sessions only, headers kept when
 *  any of their sessions match. */
function filterRows(rows: Row[], q: string): Row[] {
  if (!q) return rows;
  const out: Row[] = [];
  let header: Row | null = null;
  let pushedHeader = false;
  for (const r of rows) {
    if (r.type === "header") {
      header = { ...r, collapsed: false };
      pushedHeader = false;
      continue;
    }
    const s = r.session;
    const hay = `${s.title} ${s.branch ?? ""} ${s.agent} ${s.host}`.toLowerCase();
    if (!hay.includes(q)) continue;
    if (header && !pushedHeader) {
      out.push(header);
      pushedHeader = true;
    }
    out.push(r);
  }
  return out;
}

function GroupHeader({ row, onPress }: { row: Extract<Row, { type: "header" }>; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      className="active:opacity-70 flex-row items-center gap-1.5 px-3 pb-1 pt-2.5"
    >
      <Ionicons name={row.collapsed ? "chevron-forward" : "chevron-down"} size={11} color={COLOR.fgFaint} />
      <Ionicons name="folder-outline" size={12} color={COLOR.fgFaint} />
      <Text numberOfLines={1} className="flex-1 text-[12px] font-semibold uppercase tracking-wide text-fg-muted">
        {row.name}
      </Text>
      {row.attention > 0 ? (
        <View className="rounded-full bg-warning/15 px-1.5 py-px">
          <Text className="text-[10px] font-semibold text-warning">{row.attention}</Text>
        </View>
      ) : null}
      <Text className="text-[11px] text-fg-faint">{row.count}</Text>
    </Pressable>
  );
}

function ThreadRow({
  session: s,
  selected,
  onPress,
}: {
  session: Session;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      className={cn(
        "mx-2 rounded-lg px-2.5 py-1.5",
        selected ? "bg-accent-soft" : "active:bg-surface-hover",
      )}
    >
      <View className="flex-row items-center gap-2">
        {/* The open thread's feed already shows live state — its row stays calm. */}
        <AgentStatusIcon agent={s.agent} activity={s.activity} size={12} animated={!selected} />
        <Text
          numberOfLines={1}
          className={cn(
            "flex-1 text-[13px]",
            selected ? "font-semibold text-fg" : s.activity === "idle" ? "text-fg-muted" : "text-fg",
          )}
        >
          {s.title}
        </Text>
        <Text className="text-[11px] text-fg-faint">{timeAgo(s.updatedAt)}</Text>
      </View>
      <View className="mt-0.5 flex-row items-center gap-1.5 pl-[20px]">
        {s.branch ? (
          <Text numberOfLines={1} className="flex-1 font-mono text-[10.5px] text-fg-faint">
            ⎇ {s.branch}
          </Text>
        ) : (
          <Text numberOfLines={1} className="flex-1 text-[10.5px] text-fg-faint">
            {s.host}
          </Text>
        )}
        {s.worktree ? <Ionicons name="git-branch-outline" size={10} color={COLOR.fgFaint} /> : null}
      </View>
    </Pressable>
  );
}

function FooterIcon({
  name,
  hint,
  onPress,
}: {
  name: React.ComponentProps<typeof Ionicons>["name"];
  hint: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel={hint}
      className="active:opacity-60 h-7 w-7 items-center justify-center rounded-md"
    >
      <Ionicons name={name} size={15} color={COLOR.fgMuted} />
    </Pressable>
  );
}
