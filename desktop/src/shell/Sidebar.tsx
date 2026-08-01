/**
 * Desktop sidebar — two lists and an account row, under the window's own
 * traffic lights.
 *
 * Spaces (repo × machine) sit on top as the places you work; Sessions below is
 * one flat, chronological list rather than per-repo folders, because the thing
 * you're looking for is almost always "the thread I touched most recently",
 * not "a thread inside project X". Selecting a Space narrows the list to it.
 * Search and filters live as icons in the titlebar row so the two lists stay
 * uninterrupted.
 */
import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { LegendList } from "@legendapp/list/react-native";
import { useSelector } from "@legendapp/state/react";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import type { Session } from "@pounce/shared";
import { applyFilters, connection$, filters$, needsYou } from "@pounce/app/state/stores";
import { useDevices, useIgnoredSet, useProjectNames, useThreads } from "@pounce/app/state/db/hooks";
import { SidebarSessionsSkeleton, SidebarSpacesSkeleton } from "./SidebarSkeleton";
import { Entrance } from "./Motion";
import { AgentStatusIcon, COLOR, INPUT_TWEAKS, timeAgo } from "@pounce/app/ui";
import { T } from "@pounce/app/ui/theme";
import { GlassSurface } from "@pounce/app/ui/native/GlassSurface";
import { DragRegion, TITLEBAR_INSET, TRAFFIC_LIGHT_INSET } from "@pounce/app/ui/native/DragRegion";
import { appearance$, setAppearance, type AppearanceMode } from "@pounce/app/state/appearance";
import { nav$, selectSpace } from "../shims/router";
import { deriveSpaces, spaceKeyOf, type Space } from "./Spaces";

/** Tapping the appearance button cycles system → light → dark, and the glyph
 *  shows the mode you're in — same contract as mobile's header button. */
const NEXT_APPEARANCE: Record<AppearanceMode, AppearanceMode> = {
  system: "light",
  light: "dark",
  dark: "system",
};
const APPEARANCE_ICON: Record<AppearanceMode, React.ComponentProps<typeof Ionicons>["name"]> = {
  system: "contrast-outline",
  light: "sunny-outline",
  dark: "moon-outline",
};

/** Spaces shown before the list collapses behind a "N more" toggle. */
const SPACE_LIMIT = 6;

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
  const [searchOpen, setSearchOpen] = useState(false);
  // Shared with the shell rather than local: the same value drives this list's
  // narrowing and the Space tab beside it (see selectSpace).
  const space = useSelector(() => nav$.space.get());
  const [allSpaces, setAllSpaces] = useState(false);
  const appearanceMode = useSelector(() => appearance$.get());

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
  const filtersActive = !!(f.device || f.agent || f.repos.length || f.needsOnly || f.favOnly);
  const deviceList = useDevices();
  const threads = useThreads();
  const projectNames = useProjectNames();
  const ignored = useIgnoredSet();

  const connected = status === "connected";
  const loading = status === "connecting" || status === "reconnecting";

  const q = query.trim().toLowerCase();

  // Identical filtering to mobile Home: device · agent · project (+ ignored/
  // dotfolder hiding) via the shared predicate, then the smart "needs you"
  // narrowing (only hides non-attention threads when something needs you).
  const visible = useMemo(() => {
    let list = applyFilters(threads, {
      filters: { device: f.device, agent: f.agent, repos: f.repos },
      ignored,
      repoName: (id) => projectNames[id] ?? id,
    });
    if (f.needsOnly && list.some(needsYou)) list = list.filter(needsYou);
    return list;
  }, [threads, projectNames, ignored, f]);

  // Spaces are derived from every visible session, not the space-narrowed list —
  // otherwise selecting one would delete the others from the sidebar.
  const spaces = useMemo(
    () => deriveSpaces(visible, (id) => projectNames[id] ?? id.replace(/^repo:/, ""), needsYou),
    [visible, projectNames],
  );

  const sessions = useMemo(() => {
    let list = space ? visible.filter((s) => spaceKeyOf(s) === space) : visible;
    if (q) {
      list = list.filter((s) =>
        `${s.title} ${s.branch ?? ""} ${s.agent} ${s.host}`.toLowerCase().includes(q),
      );
    }
    return [...list].sort(
      (a, b) => rank(a) - rank(b) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
    );
  }, [visible, space, q]);

  // The entrance is a first-impression, not a permanent behaviour: it plays
  // once when the first sync lands, then switches off so scrolling a recycled
  // list doesn't re-animate rows under the cursor.
  const [settled, setSettled] = useState(false);
  const hasRows = visible.length > 0;
  useEffect(() => {
    if (!hasRows || settled) return;
    const id = setTimeout(() => setSettled(true), 900);
    return () => clearTimeout(id);
  }, [hasRows, settled]);

  const attention = useMemo(() => visible.filter(needsYou).length, [visible]);
  const online = deviceList.filter((d) => d.online);

  // "@ machine" only earns its place when there's more than one machine —
  // on a single-Mac setup it's the same suffix on every row.
  const showHost = useMemo(() => new Set(spaces.map((sp) => sp.hostId)).size > 1, [spaces]);
  // Spaces is a shortcut to the places you're working, not a directory of every
  // repo you've ever opened: past a handful it buries the session list (which is
  // what people actually navigate by), so the tail collapses behind a toggle.
  // A selected space always stays visible, even if it ranks below the cap.
  const shownSpaces = useMemo(() => {
    if (allSpaces || spaces.length <= SPACE_LIMIT) return spaces;
    const head = spaces.slice(0, SPACE_LIMIT);
    const selected = spaces.find((sp) => sp.key === space);
    return selected && !head.includes(selected) ? [...head, selected] : head;
  }, [spaces, allSpaces, space]);

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

      {/* Titlebar row: the window's traffic lights float over its left end (the
          titlebar is transparent and full-size), so the controls start past
          them and the gaps drag the window. */}
      <View style={s.titleBar}>
        {/* Behind everything: bare strip = window drag. Must stay the FIRST
            child so every control below is painted above it and keeps its
            clicks. */}
        <DragRegion style={StyleSheet.absoluteFill} />
        <View style={s.trafficLightSpacer} />
        {/* Always "hide": the shell only mounts the sidebar while it's open,
            and re-showing it is the tab strip's job. */}
        <TitleBarIcon
          name="chevron-back"
          hint="Hide sidebar"
          onPress={() => nav$.sidebar.set(false)}
        />
        <View style={s.flex1} />
        {/* Appearance is a one-click cycle here, the way mobile's header button
            works — burying a light/dark switch two levels into Settings makes
            people hunt for the thing they flip most often. */}
        <TitleBarIcon
          name={APPEARANCE_ICON[appearanceMode]}
          hint={`Appearance: ${appearanceMode}`}
          onPress={() => setAppearance(NEXT_APPEARANCE[appearanceMode])}
        />
        <TitleBarIcon
          name="search"
          hint="Search"
          active={searchOpen}
          onPress={() => {
            setSearchOpen((v) => !v);
            if (searchOpen) setQuery("");
          }}
        />
        <TitleBarIcon
          name="options-outline"
          hint="Filters"
          active={filtersActive}
          onPress={() => router.push("/filters")}
        />
      </View>

      {searchOpen ? (
        <View style={s.searchBox}>
          <Ionicons name="search" size={12} color={COLOR.fgFaint} />
          <TextInput
            {...INPUT_TWEAKS}
            value={query}
            onChangeText={setQuery}
            placeholder="Filter threads"
            placeholderTextColor={COLOR.fgFaint}
            style={s.searchInput}
            autoFocus
          />
          {/* The box filters titles/branches locally; this promotes the same
              query into full message-body search. A visible row rather than
              Enter-to-submit: rn-macos onSubmitEditing is unreliable. */}
          {query.trim() ? (
            <Pressable
              onPress={() => router.push(`/search?q=${encodeURIComponent(query.trim())}`)}
              style={({ pressed }) => pressed && s.pressed60}
            >
              <Ionicons name="arrow-forward-circle" size={15} color={COLOR.accent} />
            </Pressable>
          ) : null}
        </View>
      ) : null}

      <LegendList
        style={s.flex1}
        data={sessions}
        keyExtractor={(item) => item.id}
        // No entrance animation on these rows. LegendList recycles and
        // repositions row containers itself; wrapping each one in an extra
        // animated View made them stop responding to clicks entirely. A
        // virtualized list's rows are the list's to own — the stagger lives on
        // the Spaces block above, which is a plain mapped list.
        renderItem={({ item }) => (
          <SessionRow
            session={item}
            project={projectNames[item.repoId] ?? item.repoId.replace(/^repo:/, "")}
            showHost={showHost}
            selected={item.id === selectedId}
            onPress={() => router.push(`/session/${item.id}`)}
          />
        )}
        estimatedItemSize={54}
        recycleItems
        ListHeaderComponent={
          <View>
            <SectionHeader
              label="Spaces"
              action={{ icon: "add", hint: "New task", onPress: () => router.push("/new") }}
            />
            {(loading || !connected) && spaces.length === 0 ? (
              <SidebarSpacesSkeleton />
            ) : spaces.length === 0 ? (
              <Text style={s.sectionEmpty}>No projects synced yet.</Text>
            ) : (
              shownSpaces.map((sp, i) => (
                <Entrance key={sp.key} index={i} animate={!settled}>
                  <SpaceRow
                    space={sp}
                    showHost={showHost}
                    selected={space === sp.key}
                    // One click enters the space: narrows the list below AND
                    // opens its page. Second click leaves — a Space is
                    // somewhere you step into, not a mode you have to escape.
                    onPress={() => selectSpace(space === sp.key ? null : sp.key)}
                  />
                </Entrance>
              ))
            )}
            {spaces.length > SPACE_LIMIT ? (
              <Pressable
                onPress={() => setAllSpaces((v) => !v)}
                style={({ pressed }) => [s.moreSpaces, pressed && s.rowHover]}
              >
                <Ionicons
                  name={allSpaces ? "chevron-up" : "chevron-down"}
                  size={11}
                  color={COLOR.fgFaint}
                />
                <Text style={s.moreSpacesLabel}>
                  {allSpaces ? "Show less" : `${spaces.length - SPACE_LIMIT} more`}
                </Text>
              </Pressable>
            ) : null}
            <SectionHeader
              label="Sessions"
              trailing={
                attention > 0 ? `${attention} need${attention === 1 ? "s" : ""} you` : undefined
              }
            />
          </View>
        }
        ListEmptyComponent={
          // Warming up shows bones, not an explanation. Connecting is the normal
          // first second of every launch — announcing it with a panel makes a
          // routine wait look like a problem, and the account row already says
          // "Connecting…" for anyone who looks.
          loading || !connected ? (
            <SidebarSessionsSkeleton count={6} />
          ) : q ? (
            <Empty title={`No threads match “${query}”.`} />
          ) : space ? (
            <Empty
              title="Nothing here yet"
              body="This space has no threads matching your filters."
            />
          ) : (
            <Empty
              title="No threads yet"
              body="Start a task with the + button, or run an agent in a repo on this Mac."
              action={{ label: "Check setup", onPress: () => router.push("/diagnostics") }}
            />
          )
        }
        contentContainerStyle={s.listContent}
      />

      {/* Account row — who you are and what's reachable, one click from
          Settings. Takes the place of mobile's Settings tab. */}
      <Pressable
        onPress={() => router.push("/settings")}
        style={({ pressed }) => [s.account, pressed && s.accountHover]}
      >
        <View style={s.avatar}>
          <Ionicons name="paw" size={13} color={T.onAccent} />
        </View>
        <View style={s.flex1}>
          <Text numberOfLines={1} style={s.accountName}>
            {online.length ? online.map((d) => d.name).join(", ") : "Pounce"}
          </Text>
          <Text numberOfLines={1} style={s.accountSub}>
            {connected
              ? `${online.length} device${online.length === 1 ? "" : "s"} online`
              : loading
                ? "Connecting…"
                : "Offline"}
          </Text>
        </View>
        {/* Pairing lives with the devices it adds to. Nested inside the account
            row's Pressable, so it takes its own click and the rest of the row
            still opens Settings. */}
        <Pressable
          onPress={() => router.push("/pair")}
          accessibilityLabel="Pair a phone"
          hitSlop={4}
          style={({ pressed }) => [s.accountAction, pressed && s.rowSelected]}
        >
          <Ionicons name="qr-code-outline" size={15} color={COLOR.fgMuted} />
        </Pressable>
        {/* Explicit gear as well as the row itself: "click your name to reach
            Settings" is a convention people know from web apps, but it isn't
            discoverable, and appearance lives behind it. */}
        <Pressable
          onPress={() => router.push("/settings")}
          accessibilityLabel="Settings"
          hitSlop={4}
          style={({ pressed }) => [s.accountAction, pressed && s.rowSelected]}
        >
          <Ionicons name="settings-outline" size={15} color={COLOR.fgMuted} />
        </Pressable>
        <View
          style={[s.statusDot, connected ? s.dotSuccess : loading ? s.dotWarning : s.dotFaint]}
        />
      </Pressable>
    </View>
  );
}

function SectionHeader({
  label,
  trailing,
  action,
}: {
  label: string;
  trailing?: string;
  action?: {
    icon: React.ComponentProps<typeof Ionicons>["name"];
    hint: string;
    onPress: () => void;
  };
}) {
  return (
    <View style={s.sectionHeader}>
      <Text style={s.sectionLabel}>{label}</Text>
      <View style={s.flex1} />
      {trailing ? <Text style={s.sectionTrailing}>{trailing}</Text> : null}
      {action ? (
        <Pressable
          onPress={action.onPress}
          accessibilityLabel={action.hint}
          style={({ pressed }) => [s.sectionAction, pressed && s.pressed60]}
        >
          <Ionicons name={action.icon} size={14} color={COLOR.fgMuted} />
        </Pressable>
      ) : null}
    </View>
  );
}

function SpaceRow({
  space,
  showHost,
  selected,
  onPress,
}: {
  space: Space;
  showHost: boolean;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [s.spaceRow, selected ? s.rowSelected : pressed && s.rowHover]}
    >
      <View
        style={[
          s.spaceDot,
          space.attention > 0 ? s.dotWarning : space.live ? s.dotAccent : s.dotIdle,
        ]}
      />
      <Ionicons name="folder-outline" size={13} color={COLOR.fgMuted} />
      <Text numberOfLines={1} style={s.spaceName}>
        {space.name}
      </Text>
      {showHost ? (
        <Text numberOfLines={1} style={s.spaceHost}>
          @ {space.host}
        </Text>
      ) : null}
    </Pressable>
  );
}

function SessionRow({
  session,
  project,
  showHost,
  selected,
  onPress,
}: {
  session: Session;
  project: string;
  showHost: boolean;
  selected: boolean;
  onPress: () => void;
}) {
  // Archived threads (worktree gone) are history — they stay readable but drop
  // back so the live list reads first.
  const dim = !session.isLive;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [s.sessionRow, selected ? s.rowSelected : pressed && s.rowHover]}
    >
      <View style={s.sessionCaptionRow}>
        <Text numberOfLines={1} style={[s.sessionCaption, dim && s.dimmed]}>
          {showHost ? `${project} · ${session.host}` : project}
        </Text>
        <Text style={s.sessionTime}>{timeAgo(session.updatedAt)}</Text>
      </View>
      <Text numberOfLines={1} style={[s.sessionTitle, dim && s.dimmed]}>
        {session.title}
      </Text>
      <View style={s.sessionMetaRow}>
        {/* The open thread's own feed already shows live state — its row stays calm. */}
        <AgentStatusIcon
          agent={session.agent}
          activity={session.activity}
          size={11}
          animated={!selected}
        />
        {session.branch ? (
          <>
            <Ionicons
              name={session.worktree ? "git-network-outline" : "git-branch-outline"}
              size={10}
              color={COLOR.fgFaint}
            />
            <Text numberOfLines={1} style={s.sessionBranch}>
              {session.branch}
            </Text>
          </>
        ) : null}
      </View>
    </Pressable>
  );
}

function Empty({
  title,
  body,
  action,
}: {
  title: string;
  body?: string;
  action?: { label: string; onPress: () => void };
}) {
  return (
    <View style={s.emptyBox}>
      <Text style={s.emptyEmoji}>🐾</Text>
      <Text style={s.emptyTitle}>{title}</Text>
      {body ? <Text style={s.emptyBody}>{body}</Text> : null}
      {action ? (
        <Pressable
          onPress={action.onPress}
          style={({ pressed }) => [s.emptyAction, pressed && s.pressed70]}
        >
          <Text style={s.emptyActionLabel}>{action.label}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function TitleBarIcon({
  name,
  hint,
  active,
  onPress,
}: {
  name: React.ComponentProps<typeof Ionicons>["name"];
  hint: string;
  active?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel={hint}
      style={({ pressed }) => [s.titleBarIcon, pressed && s.rowHover]}
    >
      <Ionicons name={name} size={14} color={active ? COLOR.accent : COLOR.fgMuted} />
    </Pressable>
  );
}

const s = StyleSheet.create({
  // No background: the GlassSurface backdrop paints (vibrancy or fallback).
  root: { flex: 1 },
  flex1: { flex: 1 },
  titleBar: {
    height: TITLEBAR_INSET,
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    paddingRight: 6,
  },
  trafficLightSpacer: { width: TRAFFIC_LIGHT_INSET },
  titleBarIcon: {
    height: 24,
    width: 24,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 6,
  },
  searchBox: {
    marginHorizontal: 10,
    marginBottom: 6,
    height: 28,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 7,
    borderWidth: 1,
    borderColor: T.border,
    backgroundColor: T.surface,
    paddingHorizontal: 8,
  },
  searchInput: { flex: 1, fontSize: 12, color: T.fg, paddingVertical: 0 },
  listContent: { paddingBottom: 10 },

  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingLeft: 14,
    paddingRight: 8,
    paddingBottom: 4,
    paddingTop: 12,
  },
  sectionLabel: { fontSize: 11, fontWeight: "500", color: T.fgFaint },
  sectionTrailing: { fontSize: 10.5, color: T.warning },
  sectionAction: {
    height: 20,
    width: 20,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 5,
  },
  sectionEmpty: { paddingHorizontal: 14, paddingVertical: 4, fontSize: 11.5, color: T.fgFaint },

  rowSelected: { backgroundColor: T.surfaceHover },
  rowHover: { backgroundColor: T.surface },

  spaceRow: {
    marginHorizontal: 6,
    height: 28,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    borderRadius: 6,
    paddingHorizontal: 8,
  },
  spaceDot: { height: 6, width: 6, borderRadius: 999 },
  dotAccent: { backgroundColor: T.accent },
  dotIdle: { backgroundColor: T.fgFaint, opacity: 0.5 },
  spaceName: { flexShrink: 1, fontSize: 12.5, color: T.fg },
  moreSpaces: {
    marginHorizontal: 6,
    height: 24,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 6,
    paddingHorizontal: 8,
  },
  moreSpacesLabel: { fontSize: 11, color: T.fgFaint },
  spaceHost: { flexShrink: 0, marginLeft: "auto", fontSize: 11, color: T.fgFaint },

  sessionRow: {
    marginHorizontal: 6,
    marginBottom: 1,
    borderRadius: 7,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  sessionCaptionRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  sessionCaption: { flex: 1, fontSize: 10.5, color: T.fgFaint },
  sessionTime: { flexShrink: 0, fontSize: 10.5, color: T.fgFaint },
  sessionTitle: { marginTop: 1, fontSize: 12.5, color: T.fg },
  sessionMetaRow: { marginTop: 3, flexDirection: "row", alignItems: "center", gap: 4 },
  sessionBranch: { flex: 1, fontFamily: "JetBrainsMono", fontSize: 10, color: T.fgFaint },
  dimmed: { opacity: 0.55 },

  emptyBox: { alignItems: "center", paddingHorizontal: 20, paddingVertical: 40 },
  emptyEmoji: { fontSize: 24 },
  emptyTitle: { marginTop: 8, textAlign: "center", fontSize: 12.5, fontWeight: "600", color: T.fg },
  emptyBody: {
    marginTop: 4,
    textAlign: "center",
    fontSize: 11.5,
    lineHeight: 16,
    color: T.fgMuted,
  },
  emptyAction: {
    marginTop: 12,
    borderRadius: 7,
    borderWidth: 1,
    borderColor: T.border,
    backgroundColor: T.surface,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  emptyActionLabel: { fontSize: 11.5, fontWeight: "500", color: T.fgMuted },

  account: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderTopWidth: 1,
    borderColor: T.border,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  accountHover: { backgroundColor: T.surface },
  avatar: {
    height: 24,
    width: 24,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 999,
    backgroundColor: T.accent,
  },
  accountAction: {
    height: 24,
    width: 24,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 6,
  },
  accountName: { fontSize: 12, fontWeight: "500", color: T.fg },
  accountSub: { fontSize: 10.5, color: T.fgFaint },
  statusDot: { height: 7, width: 7, borderRadius: 999 },
  dotSuccess: { backgroundColor: T.success },
  dotWarning: { backgroundColor: T.warning },
  dotFaint: { backgroundColor: T.fgFaint },

  pressed60: { opacity: 0.6 },
  pressed70: { opacity: 0.7 },
});
