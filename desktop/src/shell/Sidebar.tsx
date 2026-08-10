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
import { Pressable, Text, TextInput, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
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
import { GlassSurface } from "@pounce/app/ui/native/GlassSurface";
import { DragRegion, TITLEBAR_INSET } from "@pounce/app/ui/native/DragRegion";
import { useTrafficLightInset } from "./fullscreen";
import { appearance$, setAppearance, type AppearanceMode } from "@pounce/app/state/appearance";
import { useAccessRequests } from "./accessRequests";
import { nav$, selectSpace } from "../shims/router";
import { deriveSpaces, spaceKeyOf, type Space } from "./Spaces";
import { SidebarGlyph } from "./icons";
import { ThemeButton } from "./ThemeMenu";

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

/**
 * Where the titlebar's first control starts in full screen.
 *
 * Sidebar content sits 14pt from the edge (see `sectionHeader`), and the 15pt
 * glyph is centred in a 24pt button — so the BUTTON starts at 10 to put the
 * glyph's own left edge on that 14pt line. Aligning the button box instead
 * would leave the icon looking 4pt indented from everything under it.
 */
const TITLE_EDGE_INSET = 10;

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
  const trafficLightInset = useTrafficLightInset(TITLE_EDGE_INSET);

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
        fallbackColor={COLOR.bgElevated}
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
        {/* Collapses in full screen, where macOS hides the traffic lights —
            otherwise this button sits 78pt in from nothing. */}
        <View style={{ width: trafficLightInset }} />
        {/* Always "hide": the shell only mounts the sidebar while it's open,
            and re-showing it is the tab strip's job. */}
        <Pressable
          onPress={() => nav$.sidebar.set(false)}
          accessibilityLabel="Hide sidebar"
          style={({ pressed }) => [s.titleBarIcon, pressed && s.rowHover]}
        >
          <SidebarGlyph color={COLOR.fgMuted} />
        </Pressable>
        <View style={s.flex1} />
        {/* Someone is asking to read this machine's threads. Only ever shown
            when there IS something to answer: a permanently-present bell that
            is empty 99% of the time teaches people to ignore it, and this is
            the one notification here that a human must actually act on. */}
        <AccessBell />
        {/* Appearance is a one-click cycle here, the way mobile's header button
            works — burying a light/dark switch two levels into Settings makes
            people hunt for the thing they flip most often. */}
        <TitleBarIcon
          name={APPEARANCE_ICON[appearanceMode]}
          hint={`Appearance: ${appearanceMode}`}
          onPress={() => setAppearance(NEXT_APPEARANCE[appearanceMode])}
        />
        {/* Theme sits beside appearance because they're one thought: the theme
            is the palette, appearance is the ground it paints on. A palette is
            picked by looking rather than by name, so this one opens a menu
            instead of cycling. */}
        <ThemeButton />
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
          {/* Clear. Without this the only ways out were closing the whole
              search toggle or selecting the text and deleting it — and the
              arrow beside it navigates rather than clears, so it reads like a
              clear button that isn't one. */}
          {query ? (
            <Pressable
              onPress={() => setQuery("")}
              accessibilityLabel="Clear search"
              style={({ pressed }) => pressed && s.pressed60}
            >
              <Ionicons name="close-circle" size={15} color={COLOR.fgFaint} />
            </Pressable>
          ) : null}
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
        {/* The mark IS the status light. A separate dot at the far end of the
            row said the same thing a second time, at the edge of where anyone
            looks — whereas the paw is the first thing in the row and already
            carries the eye. Grey when there's nothing reachable, accent when
            there is. */}
        <View style={[s.avatar, connected ? s.avatarOnline : s.avatarOffline]}>
          <Ionicons name="paw" size={13} color={connected ? COLOR.onAccent : COLOR.fgMuted} />
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
        {/* Other Macs on this network — and, when one of them is asking for
            access, the way in to answering. The dot is the only notice a person
            gets while the app is in front of them, so it takes priority over
            the plain "go browse peers" destination. */}
        <PeersButton />
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

/**
 * How many machines are waiting on an answer from this one.
 *
 * The list itself lives in ./accessRequests, on ONE poll shared with the alert
 * that interrupts you — three components each running their own interval meant
 * three answers that could disagree for a few seconds, so the bell could show a
 * count the alert had not noticed yet.
 */
function usePendingAccess(): number {
  return useAccessRequests().length;
}

/** The notification: a bell that exists only while something needs answering,
 *  with the count on it. Sits with Search and Filters because that row is where
 *  the eye already goes for "state of this window". */
function AccessBell() {
  const router = useRouter();
  const waiting = usePendingAccess();
  if (!waiting) return null;
  return (
    <Pressable
      onPress={() => router.push("/access")}
      // Distinct from the account row's peers button, which also badges and
      // also opens /access — two controls answering to one name makes them
      // indistinguishable to VoiceOver and to anything driving the UI.
      accessibilityLabel={`Notifications: ${waiting} access request${waiting === 1 ? "" : "s"} waiting`}
      style={({ pressed }) => [s.titleBarIcon, pressed && s.rowHover]}
    >
      <Ionicons name="notifications" size={14} color={COLOR.accent} />
      <View style={s.bellCount}>
        <Text style={s.bellCountText}>{waiting > 9 ? "9+" : waiting}</Text>
      </View>
    </Pressable>
  );
}

/**
 * Connect — machines on this network — and the badge for someone asking to
 * reach this one.
 *
 * An access request is answered by a person, so it has to be VISIBLE to one —
 * the bridge also fires a system notification, but that is for when the window
 * is buried, and a badge is what works when it isn't. While a request is
 * waiting the button changes destination: the thing to do is answer it, not go
 * browsing.
 */
function PeersButton() {
  const router = useRouter();
  const waiting = usePendingAccess();

  return (
    <Pressable
      // Always the hub, never conditional. Routing this to /access only while
      // something was pending meant that with no request in flight there was NO
      // way to reach the grants you had already given — you could not see them,
      // and you could not take them back.
      onPress={() => router.push("/peers")}
      accessibilityLabel={waiting ? `Connect: ${waiting} access request waiting` : "Connect"}
      hitSlop={4}
      style={({ pressed }) => [s.accountAction, pressed && s.rowSelected]}
    >
      <Ionicons
        name="git-network-outline"
        size={15}
        color={waiting ? COLOR.accent : COLOR.fgMuted}
      />
      {waiting ? <View style={s.peerBadge} /> : null}
    </Pressable>
  );
}

const s = StyleSheet.create((theme) => ({
  // No background: the GlassSurface backdrop paints (vibrancy or fallback).
  root: { flex: 1 },
  flex1: { flex: 1 },
  titleBar: {
    height: TITLEBAR_INSET,
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    paddingRight: 6,
    // AppKit centres the traffic lights at y=15.5 in this window, while a 38pt
    // row centres its own children at 19 — so the icons sat 3pt low against the
    // buttons beside them. Trimming the content box from the bottom lands both
    // on the same line. (Measured off a capture; not a guess.)
    paddingBottom: 7,
  },
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
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: 8,
  },
  searchInput: { flex: 1, fontSize: 12, color: theme.colors.fg, paddingVertical: 0 },
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
  sectionLabel: { fontSize: 11, fontWeight: "500", color: theme.colors.fgFaint },
  sectionTrailing: { fontSize: 10.5, color: theme.colors.warning },
  sectionAction: {
    height: 20,
    width: 20,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 5,
  },
  sectionEmpty: {
    paddingHorizontal: 14,
    paddingVertical: 4,
    fontSize: 11.5,
    color: theme.colors.fgFaint,
  },

  rowSelected: { backgroundColor: theme.colors.surfaceHover },
  rowHover: { backgroundColor: theme.colors.surface },

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
  dotAccent: { backgroundColor: theme.colors.accent },
  dotIdle: { backgroundColor: theme.colors.fgFaint, opacity: 0.5 },
  spaceName: { flexShrink: 1, fontSize: 12.5, color: theme.colors.fg },
  moreSpaces: {
    marginHorizontal: 6,
    height: 24,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 6,
    paddingHorizontal: 8,
  },
  moreSpacesLabel: { fontSize: 11, color: theme.colors.fgFaint },
  spaceHost: { flexShrink: 0, marginLeft: "auto", fontSize: 11, color: theme.colors.fgFaint },

  sessionRow: {
    marginHorizontal: 6,
    marginBottom: 1,
    borderRadius: 7,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  sessionCaptionRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  sessionCaption: { flex: 1, fontSize: 10.5, color: theme.colors.fgFaint },
  sessionTime: { flexShrink: 0, fontSize: 10.5, color: theme.colors.fgFaint },
  sessionTitle: { marginTop: 1, fontSize: 12.5, color: theme.colors.fg },
  sessionMetaRow: { marginTop: 3, flexDirection: "row", alignItems: "center", gap: 4 },
  sessionBranch: {
    flex: 1,
    fontFamily: "JetBrainsMono",
    fontSize: 10,
    color: theme.colors.fgFaint,
  },
  dimmed: { opacity: 0.55 },

  emptyBox: { alignItems: "center", paddingHorizontal: 20, paddingVertical: 40 },
  emptyTitle: {
    marginTop: 8,
    textAlign: "center",
    fontSize: 12.5,
    fontWeight: "600",
    color: theme.colors.fg,
  },
  emptyBody: {
    marginTop: 4,
    textAlign: "center",
    fontSize: 11.5,
    lineHeight: 16,
    color: theme.colors.fgMuted,
  },
  emptyAction: {
    marginTop: 12,
    borderRadius: 7,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  emptyActionLabel: { fontSize: 11.5, fontWeight: "500", color: theme.colors.fgMuted },

  account: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderTopWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  accountHover: { backgroundColor: theme.colors.surface },
  avatar: {
    height: 24,
    width: 24,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 999,
  },
  avatarOnline: { backgroundColor: theme.colors.accent },
  // Connecting counts as offline here on purpose: this is a two-state light,
  // and a third colour mid-handshake would flicker on every reconnect. The
  // subtitle beneath already says "Connecting…" for anyone watching.
  avatarOffline: { backgroundColor: theme.colors.surfaceHover },
  accountAction: {
    height: 24,
    width: 24,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 6,
  },
  // Corner pip on the peers icon. Ringed in the sidebar's own background so it
  // reads as a badge rather than as part of the glyph underneath.
  peerBadge: {
    position: "absolute",
    top: 3,
    right: 3,
    height: 7,
    width: 7,
    borderRadius: 999,
    borderWidth: 1.5,
    borderColor: theme.colors.bg,
    backgroundColor: theme.colors.accent,
  },
  // Count sits on the bell rather than beside it: the titlebar row is icons
  // only, and a number in the flow would break that rhythm.
  bellCount: {
    position: "absolute",
    top: 1,
    right: 0,
    minWidth: 12,
    height: 12,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 999,
    paddingHorizontal: 2,
    backgroundColor: theme.colors.accent,
  },
  bellCountText: { fontSize: 8, fontWeight: "700", color: theme.colors.onAccent },
  accountName: { fontSize: 12, fontWeight: "500", color: theme.colors.fg },
  accountSub: { fontSize: 10.5, color: theme.colors.fgFaint },
  dotWarning: { backgroundColor: theme.colors.warning },

  pressed60: { opacity: 0.6 },
  pressed70: { opacity: 0.7 },
}));
