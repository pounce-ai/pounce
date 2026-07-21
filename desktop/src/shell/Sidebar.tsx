/**
 * Desktop sidebar: search + new task on top, threads grouped under collapsible
 * project (repo) sections, connection/status footer. Dense flat rows rather
 * than the mobile card list; the selected thread is highlighted and groups
 * needing attention float to the top (same ranking as mobile Home).
 */
import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { LegendList } from "@legendapp/list/react-native";
import { useSelector } from "@legendapp/state/react";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import type { Session } from "@pounce/shared";
import { applyFilters, connection$, filters$, needsYou } from "@pounce/app/state/stores";
import { useDevices, useIgnoredSet, useProjectNames, useThreads } from "@pounce/app/state/db/hooks";
import { SessionListSkeleton } from "@pounce/app/components/Skeleton";
import { LiveStrip } from "@pounce/app/components/LiveStrip";
import { FilterButton } from "@pounce/app/components/FilterSheet";
import { AgentStatusIcon, COLOR, INPUT_TWEAKS, timeAgo } from "@pounce/app/ui";
import { T } from "@pounce/app/ui/theme";
import { GlassSurface } from "@pounce/app/ui/native/GlassSurface";
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
    <View style={s.root}>
      {/* Behind-window vibrancy: the standard macOS sidebar material blurring
          the desktop through the window. An absolute-fill backdrop (content
          stays in ordinary Views above it); non-macOS/stale binaries paint the
          old opaque bgElevated instead. */}
      <GlassSurface
        material="sidebar"
        blendingMode="behindWindow"
        fallbackColor={T.bgElevated}
        style={StyleSheet.absoluteFill}
      />
      {/* Top bar: search + new */}
      <View style={s.topBar}>
        <View style={s.searchBox}>
          <Ionicons name="search" size={13} color={COLOR.fgFaint} />
          <TextInput {...INPUT_TWEAKS}
            value={query}
            onChangeText={setQuery}
            placeholder="Search threads"
            placeholderTextColor={COLOR.fgFaint}
            style={s.searchInput}
            // Enter promotes the sidebar's quick metadata filter into the full
            // Search modal (message-body search included), seeded with the query.
            returnKeyType="search"
            onSubmitEditing={() => {
              const q = query.trim();
              if (q) router.push(`/search?q=${encodeURIComponent(q)}`);
            }}
          />
          {query ? (
            <Pressable onPress={() => setQuery("")} style={({ pressed }) => pressed && s.pressed60}>
              <Ionicons name="close-circle" size={14} color={COLOR.fgFaint} />
            </Pressable>
          ) : null}
        </View>
        <FilterButton active={false} onPress={() => router.push("/filters")} />
        <Pressable
          onPress={() => router.push("/new")}
          style={({ pressed }) => [s.newBtn, pressed && s.pressed80]}
        >
          <Ionicons name="add" size={18} color={T.onAccent} />
        </Pressable>
      </View>

      {/* Promote the quick metadata filter into full message-body search (the
          /search modal, seeded). A visible row rather than Enter-to-submit:
          rn-macos onSubmitEditing is unreliable, and desktop is mouse-first. */}
      {query.trim() ? (
        <Pressable
          onPress={() => router.push(`/search?q=${encodeURIComponent(query.trim())}`)}
          style={({ pressed }) => [s.searchPromote, pressed && s.pressed70]}
        >
          <Ionicons name="chatbubbles-outline" size={12} color={COLOR.accent} />
          <Text numberOfLines={1} style={s.searchPromoteText}>
            Search messages for “{query.trim()}”
          </Text>
          <Ionicons name="chevron-forward" size={11} color={COLOR.fgFaint} />
        </Pressable>
      ) : null}

      {attention > 0 ? (
        <View style={s.attentionBanner}>
          <Ionicons name="alert-circle" size={12} color={COLOR.fgMuted} />
          <Text style={s.attentionText}>
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
            <View style={s.emptyBox}>
              <Text style={s.emptyEmoji}>🐾</Text>
              <Text style={s.emptyTitle}>Starting up…</Text>
              <Text style={s.emptyBody}>
                The agent host on this Mac is warming up. Threads appear here automatically.
              </Text>
            </View>
          ) : q ? (
            <View style={s.emptyBox}>
              <Text style={s.emptyNoMatch}>No threads match “{query}”.</Text>
            </View>
          ) : (
            <View style={s.emptyBox}>
              <Text style={s.emptyEmoji}>🐾</Text>
              <Text style={s.emptyTitle}>No threads yet</Text>
              <Text style={[s.emptyBody, s.emptyBodyLeading]}>
                Start a task with the + button, or run an agent in a repo on this Mac.
              </Text>
              <Pressable
                onPress={() => router.push("/diagnostics")}
                style={({ pressed }) => [s.checkSetupBtn, pressed && s.pressed70]}
              >
                <Ionicons name="medkit-outline" size={13} color={COLOR.fgMuted} />
                <Text style={s.checkSetupLabel}>Check setup</Text>
              </Pressable>
            </View>
          )
        }
        contentContainerStyle={{ paddingBottom: 12 }}
      />

      {/* Footer: connection + utilities */}
      <View style={s.footer}>
        <View style={s.footerStatus}>
          <View
            style={[s.statusDot, connected ? s.dotSuccess : loading ? s.dotWarning : s.dotFaint]}
          />
          <Text numberOfLines={1} style={s.footerStatusText}>
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
      style={({ pressed }) => [s.groupHeader, pressed && s.pressed70]}
    >
      <Ionicons name={row.collapsed ? "chevron-forward" : "chevron-down"} size={11} color={COLOR.fgFaint} />
      <Ionicons name="folder-outline" size={12} color={COLOR.fgFaint} />
      <Text numberOfLines={1} style={s.groupName}>
        {row.name}
      </Text>
      {row.attention > 0 ? (
        <View style={s.groupBadge}>
          <Text style={s.groupBadgeText}>{row.attention}</Text>
        </View>
      ) : null}
      <Text style={s.groupCount}>{row.count}</Text>
    </Pressable>
  );
}

function ThreadRow({
  session: s2,
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
      style={({ pressed }) => [
        s.threadRow,
        selected ? s.threadRowSelected : pressed && s.threadRowHover,
      ]}
    >
      <View style={s.threadTitleRow}>
        {/* The open thread's feed already shows live state — its row stays calm. */}
        <AgentStatusIcon agent={s2.agent} activity={s2.activity} size={12} animated={!selected} />
        <Text
          numberOfLines={1}
          style={[
            s.threadTitle,
            selected ? s.threadTitleSelected : s2.activity === "idle" ? s.threadTitleIdle : null,
          ]}
        >
          {s2.title}
        </Text>
        <Text style={s.threadTime}>{timeAgo(s2.updatedAt)}</Text>
      </View>
      <View style={s.threadMetaRow}>
        {s2.branch ? (
          <Text numberOfLines={1} style={s.threadBranch}>
            ⎇ {s2.branch}
          </Text>
        ) : (
          <Text numberOfLines={1} style={s.threadHost}>
            {s2.host}
          </Text>
        )}
        {s2.worktree ? <Ionicons name="git-branch-outline" size={10} color={COLOR.fgFaint} /> : null}
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
      style={({ pressed }) => [s.footerIcon, pressed && s.pressed60]}
    >
      <Ionicons name={name} size={15} color={COLOR.fgMuted} />
    </Pressable>
  );
}

/* T.warning is a PlatformColor on macOS, so translucent "warning/10|15" tints
 * keep literal rgba values (matching the palette's warning hex). */
const WARNING_TINT_10 = "rgba(210, 153, 34, 0.1)";
const WARNING_TINT_15 = T.warningSoft;

const s = StyleSheet.create({
  // No background: the GlassSurface backdrop paints (vibrancy or fallback).
  root: { flex: 1 },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingBottom: 8,
    paddingTop: 12,
  },
  searchBox: {
    height: 32,
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: T.border,
    backgroundColor: T.surface,
    paddingHorizontal: 10,
  },
  searchInput: { flex: 1, fontSize: 13, color: T.fg, paddingVertical: 0 },
  newBtn: {
    height: 32,
    width: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
    backgroundColor: T.accent,
  },
  searchPromote: {
    marginHorizontal: 12,
    marginBottom: 4,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 6,
    backgroundColor: T.surface,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  searchPromoteText: { flex: 1, fontSize: 11, fontWeight: "500", color: T.fgMuted },
  attentionBanner: {
    marginHorizontal: 12,
    marginBottom: 4,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 6,
    backgroundColor: WARNING_TINT_10,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  attentionText: { fontSize: 11, fontWeight: "500", color: T.warning },
  emptyBox: { alignItems: "center", paddingHorizontal: 24, paddingVertical: 64 },
  emptyEmoji: { fontSize: 28 },
  emptyTitle: { marginTop: 8, textAlign: "center", fontSize: 13, fontWeight: "600", color: T.fg },
  emptyBody: { marginTop: 4, textAlign: "center", fontSize: 12, color: T.fgMuted },
  emptyBodyLeading: { lineHeight: 17 },
  emptyNoMatch: { textAlign: "center", fontSize: 12, color: T.fgMuted },
  checkSetupBtn: {
    marginTop: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: T.border,
    backgroundColor: T.surface,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  checkSetupLabel: { fontSize: 12, fontWeight: "500", color: T.fgMuted },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderTopWidth: 1,
    borderColor: T.border,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  footerStatus: { flex: 1, flexDirection: "row", alignItems: "center", gap: 6 },
  statusDot: { height: 8, width: 8, borderRadius: 999 },
  dotSuccess: { backgroundColor: T.success },
  dotWarning: { backgroundColor: T.warning },
  dotFaint: { backgroundColor: T.fgFaint },
  footerStatusText: { fontSize: 11, color: T.fgMuted },
  footerIcon: {
    height: 28,
    width: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 6,
  },
  groupHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingBottom: 4,
    paddingTop: 10,
  },
  groupName: {
    flex: 1,
    fontSize: 12,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    color: T.fgMuted,
  },
  groupBadge: {
    borderRadius: 999,
    backgroundColor: WARNING_TINT_15,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  groupBadgeText: { fontSize: 10, fontWeight: "600", color: T.warning },
  groupCount: { fontSize: 11, color: T.fgFaint },
  threadRow: {
    marginHorizontal: 8,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  threadRowSelected: { backgroundColor: T.accentSoft },
  threadRowHover: { backgroundColor: T.surfaceHover },
  threadTitleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  threadTitle: { flex: 1, fontSize: 13, color: T.fg },
  threadTitleSelected: { fontWeight: "600", color: T.fg },
  threadTitleIdle: { color: T.fgMuted },
  threadTime: { fontSize: 11, color: T.fgFaint },
  threadMetaRow: {
    marginTop: 2,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingLeft: 20,
  },
  threadBranch: { flex: 1, fontFamily: "JetBrainsMono", fontSize: 10.5, color: T.fgFaint },
  threadHost: { flex: 1, fontSize: 10.5, color: T.fgFaint },
  pressed60: { opacity: 0.6 },
  pressed70: { opacity: 0.7 },
  pressed80: { opacity: 0.8 },
});
