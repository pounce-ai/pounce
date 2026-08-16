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
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Animated, Easing, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { LegendList } from "@legendapp/list/react-native";
import { useSelector } from "@legendapp/state/react";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import type { Session } from "@pounce/shared";
import {
  applyFilters,
  connection$,
  filters$,
  needsYou,
  recentlyActive,
} from "@pounce/app/state/stores";
import { canSettle, partitionSettled } from "@pounce/app/state/settled";
import { draftTitle, drafts$, listDrafts, newDraft, removeDraft } from "@pounce/app/state/drafts";
import {
  autoSettleDays$,
  loadSettled,
  settled$,
  toggleSettled,
} from "@pounce/app/state/settledStore";
import { useDevices, useIgnoredSet, useProjectNames, useThreads } from "@pounce/app/state/db/hooks";
import { isThisMachine } from "@pounce/app/services/deviceProvenance";
import { deviceLabel } from "@pounce/app/state/stores";
import { SidebarSessionsSkeleton, SidebarSpacesSkeleton } from "./SidebarSkeleton";
import { Entrance } from "./Motion";
import { COLOR, INPUT_TWEAKS, TimeAgo } from "@pounce/app/ui";
import { useAgentHex } from "@pounce/app/ui/useThemeHex";
import { useAttentionClock } from "@pounce/app/hooks/useAttentionClock";
import { GlassSurface } from "@pounce/app/ui/native/GlassSurface";
import { DragRegion, TITLEBAR_INSET } from "@pounce/app/ui/native/DragRegion";
import { useTrafficLightInset } from "./fullscreen";
import { appearance$, setAppearance, type AppearanceMode } from "@pounce/app/state/appearance";
import { useAccessRequests } from "./accessRequests";
import { nav$, selectSpace } from "../shims/router";
import { deriveSpaces, spaceKeyFor, spaceKeyOf, type Space } from "./Spaces";
import { SidebarGlyph } from "./icons";
import { ThemeButton } from "./ThemeMenu";

const EMPTY_ROWS: Session[] = [];

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
  if (s.isResumable) return 2;
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
    show: filters$.show.get(),
    favOnly: filters$.favOnly.get(),
  }));
  /** The sidebar has its own Needs-you and Settled shelves, so it reads only
   *  one thing from the Show buckets: whether the user asked to see NOTHING but
   *  what's waiting on them. The archive bucket is the phone's way of reaching
   *  something the sidebar always shows. */
  const needsOnly = f.show.length === 1 && f.show[0] === "needs";
  const filtersActive = !!(f.device || f.agent || f.repos.length || needsOnly || f.favOnly);
  // Bound once for the list: every row's edge and glyph read from it.
  const agentHexOf = useAgentHex();
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
    if (needsOnly && list.some(needsYou)) list = list.filter(needsYou);
    return list;
  }, [threads, projectNames, ignored, f, needsOnly]);

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

  // The inbox split. `partitionSettled` owns the rule — including that busy or
  // blocked work is never hidden, whatever the user settled earlier.
  const overrides = useSelector(() => ({ ...settled$.get() }));
  // Passed in rather than read inside `settleOptions`, so the policy is a real
  // dependency: turning auto-settle off has to re-partition, and a dep the
  // linter can't see is one a later edit will drop.
  const autoSettleAfterDays = useSelector(() => autoSettleDays$.get());
  const { active, settled: done } = useMemo(
    () =>
      partitionSettled(sessions, overrides, {
        now: new Date().toISOString(),
        autoSettleAfterDays,
      }),
    [sessions, overrides, autoSettleAfterDays],
  );
  const [showSettled, setShowSettled] = useState(false);
  // Drafts and Needs you open by default — they are short, and hiding the two
  // groups that are waiting on the user would defeat pulling them out at all.
  // Settled stays closed: it is the archive, and it is long.
  const [showDrafts, setShowDrafts] = useState(true);
  const [showBlocked, setShowBlocked] = useState(true);
  const [showRunning, setShowRunning] = useState(true);
  const [showOthers, setShowOthers] = useState(true);
  // Threads blocked on the user get their own section rather than just sorting
  // first: "at the top" and "a place of its own" read differently once the list
  // is long, and this is the one group you must not scroll past.
  // Three cuts, in the order you scan for them: waiting on you, moving right
  // now, everything else. Attention wins over running when a thread is both —
  // a blocked agent may still report itself busy, and "it needs you" is the
  // fact you act on.
  // needsYou reads the wall clock (ATTENTION_GRACE_MS), so this memo has to be
  // woken when a pending thread finishes serving that period — nothing else
  // changes at that moment.
  const attentionTick = useAttentionClock(active);
  const { blocked, recent, rest } = useMemo(() => {
    const blocked: Session[] = [];
    const recent: Session[] = [];
    const rest: Session[] = [];
    for (const t of active) {
      if (needsYou(t)) blocked.push(t);
      // Not just "running": a thread keeps its place for a few minutes after
      // the agent stops, so finishing a turn doesn't move the row out from
      // under the person watching it. See RECENT_WINDOW_MS.
      else if (recentlyActive(t)) recent.push(t);
      else rest.push(t);
    }
    return { blocked, recent, rest };
  }, [active, attentionTick]);
  // Parked tasks, above the threads: a draft is the newest thing you touched
  // and the only row here that is waiting on YOU rather than on an agent.
  // Narrowed with the space, like everything else in this list.
  const allDrafts = useSelector(() => listDrafts(drafts$.get()));
  const drafts = useMemo(
    () => (space ? allDrafts.filter((d) => spaceKeyFor(d.hostId, d.repoId) === space) : allDrafts),
    [allDrafts, space],
  );
  // One read per connect: the map is small, and the bridge owns it.
  useEffect(() => {
    if (connected) void loadSettled();
  }, [connected]);

  // The entrance is a first-impression, not a permanent behaviour: it plays
  // once when the first sync lands, then switches off so scrolling a recycled
  // list doesn't re-animate rows under the cursor.
  // `pristine` in the form-field sense: the list as first rendered, before the
  // user has had a chance to touch it. The entrance plays once while it holds.
  const [pristine, setPristine] = useState(true);
  const hasRows = visible.length > 0;
  useEffect(() => {
    if (!hasRows || !pristine) return;
    const id = setTimeout(() => setPristine(false), 900);
    return () => clearTimeout(id);
  }, [hasRows, pristine]);

  const online = deviceList.filter((d) => d.online);

  /**
   * The "@ machine" chip for a row, or null to leave it off.
   *
   * Three rules, and they all say the same thing — the chip is only worth space
   * when it tells you something you didn't know:
   *   nothing on a single-machine setup, where it's the same suffix everywhere;
   *   nothing for the machine you're sitting at, which is the default reading
   *     of a row with no chip;
   *   and the name you gave the machine, not the hostname its bridge reports,
   *     since a rename you made is the name you'll be looking for.
   */
  const hostChip = useMemo(() => {
    const multi = new Set(spaces.map((sp) => sp.hostId)).size > 1;
    const localId = deviceList.find((d) => isThisMachine(d.url))?.id ?? null;
    return (hostId: string, fallback: string): string | null => {
      if (!multi || hostId === localId) return null;
      return deviceLabel(hostId, deviceList.find((d) => d.id === hostId)?.name ?? fallback);
    };
  }, [spaces, deviceList]);
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
      {/* No fallbackColor: passing COLOR.bgElevated here CAPTURES the hex as
          a prop at this render-once component's render, so a theme flip left
          the backdrop painted in the previous theme. GlassSurface subscribes
          to the theme itself and defaults to bgElevated; let it. */}
      <GlassSurface
        material="sidebar"
        blendingMode="behindWindow"
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
        data={showOthers ? rest : EMPTY_ROWS}
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
            hostChip={hostChip}
            selected={item.id === selectedId}
            onPress={() => router.push(`/session/${item.id}`)}
            onSettle={canSettle(item) ? () => void toggleSettled(item) : undefined}
            agentHue={agentHexOf(item.agent, COLOR.fgFaint as string)!}
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
                <Entrance key={sp.key} index={i} animate={pristine}>
                  <SpaceRow
                    space={sp}
                    hostChip={hostChip}
                    selected={space === sp.key}
                    // One click enters the space: narrows the list below AND
                    // opens its page. Second click leaves — a Space is
                    // somewhere you step into, not a mode you have to escape.
                    onPress={() => selectSpace(space === sp.key ? null : sp.key)}
                    onCompose={() =>
                      router.push(
                        `/new?draft=${newDraft({ hostId: sp.hostId, repoId: sp.repoId }).id}`,
                      )
                    }
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
            {/* SESSIONS is the heading; everything below is a cut of it.
                The order is who is waiting on whom: your unsent drafts, then
                what the agents need from you, then everything still running.
                Settled is the fourth cut and lives pinned at the bottom. */}
            <SectionHeader label="Sessions" strong />

            <Shelf
              label="Drafts"
              count={drafts.length}
              open={showDrafts}
              onToggle={() => setShowDrafts((v) => !v)}
            >
              {drafts.map((d) => (
                <Pressable
                  key={d.id}
                  onPress={() => router.push(`/new?draft=${d.id}`)}
                  style={({ pressed }) => [s.draftRow, pressed && s.rowHover]}
                >
                  <Ionicons name="create-outline" size={12} color={COLOR.accent} />
                  <Text numberOfLines={1} style={s.draftTitle}>
                    {draftTitle(d)}
                  </Text>
                  <Pressable
                    onPress={() => removeDraft(d.id)}
                    hitSlop={6}
                    accessibilityRole="button"
                    accessibilityLabel={`Discard ${draftTitle(d)}`}
                    style={({ pressed }) => pressed && s.pressed60}
                  >
                    <Ionicons name="close" size={12} color={COLOR.fgFaint} />
                  </Pressable>
                </Pressable>
              ))}
            </Shelf>

            <Shelf
              label="Needs attention"
              count={blocked.length}
              badge
              open={showBlocked}
              onToggle={() => setShowBlocked((v) => !v)}
              empty="Nothing is waiting on you."
            >
              {blocked.map((item) => (
                <SessionRow
                  key={item.id}
                  session={item}
                  project={projectNames[item.repoId] ?? item.repoId.replace(/^repo:/, "")}
                  hostChip={hostChip}
                  selected={item.id === selectedId}
                  onPress={() => router.push(`/session/${item.id}`)}
                  onSettle={canSettle(item) ? () => void toggleSettled(item) : undefined}
                  agentHue={agentHexOf(item.agent, COLOR.fgFaint as string)!}
                />
              ))}
            </Shelf>

            {/* Work in flight, pulled out of the main list. It is the other
                thing you scan for — "is anything moving?" — and previously it
                only sorted to the top, which reads as ordinary once the list is
                long enough to scroll. */}
            <Shelf
              label="Recent"
              count={recent.length}
              open={showRunning}
              onToggle={() => setShowRunning((v) => !v)}
            >
              {recent.map((item) => (
                <SessionRow
                  key={item.id}
                  session={item}
                  project={projectNames[item.repoId] ?? item.repoId.replace(/^repo:/, "")}
                  hostChip={hostChip}
                  selected={item.id === selectedId}
                  onPress={() => router.push(`/session/${item.id}`)}
                  onSettle={canSettle(item) ? () => void toggleSettled(item) : undefined}
                  agentHue={agentHexOf(item.agent, COLOR.fgFaint as string)!}
                />
              ))}
            </Shelf>

            {/* Everything else, headed and collapsible like its siblings. It
                used to run on unlabelled — which left the longest group in the
                list as the only one you could neither name nor fold away. */}
            {rest.length ? (
              <ShelfHeader
                label="Others"
                count={rest.length}
                open={showOthers}
                onToggle={() => setShowOthers((v) => !v)}
              />
            ) : null}
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

      {/* Settled — the fourth cut of Sessions, pinned rather than scrolling
          with the list. As a footer it sat below every thread, so reaching it
          meant scrolling past 177 of them: a drawer you have to hunt for is not
          a drawer. Same Shelf as Drafts and Needs you, so the three behave
          identically. */}
      <Shelf
        label="Settled"
        count={done.length}
        open={showSettled}
        onToggle={() => setShowSettled((v) => !v)}
        pinned
      >
        {done.map((item) => (
          <Pressable
            key={item.id}
            onPress={() => router.push(`/session/${item.id}`)}
            style={({ pressed }) => [
              s.settledRow,
              item.id === selectedId ? s.rowSelected : pressed && s.rowHover,
            ]}
          >
            <Text numberOfLines={1} style={s.settledTitle}>
              {item.title}
            </Text>
            <Pressable
              onPress={() => void toggleSettled(item)}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel={`Bring back ${item.title}`}
              style={({ pressed }) => pressed && s.pressed60}
            >
              <Ionicons name="arrow-up-circle-outline" size={13} color={COLOR.fgFaint} />
            </Pressable>
          </Pressable>
        ))}
      </Shelf>

      {/* Account row — who you are and what's reachable, one click from
          Settings. Takes the place of mobile's Settings tab. */}
      <Pressable
        onPress={() => router.push("/settings")}
        style={({ pressed }) => [s.account, pressed && s.accountHover]}
      >
        {/* A plain light, not the cat. The artwork earned its place as an app
            icon and lost it here: at 24pt in the corner of every window it read
            as decoration, and decoration in the one row that reports status
            makes the status harder to find, not easier. The dot leads the row,
            so it is the first thing the eye crosses on the way to the name. */}
        <View style={[s.statusDot, connected ? s.statusDotOn : s.statusDotOff]} />
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

/**
 * A collapsible group inside the Sessions list.
 *
 * Drafts, Needs you and Settled are the same shape — three shelves around the
 * plain list of everything else — so they share one component. Written out
 * three times they would drift, and a sidebar whose groups behave differently
 * from each other is harder to read than one with no groups at all.
 */
function Shelf({
  label,
  count,
  open,
  onToggle,
  children,
  pinned,
  empty,
  badge,
}: {
  label: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
  /** Settled sits below the list rather than scrolling with it, so it needs the
   *  hairline and its own bounded scroll. */
  pinned?: boolean;
  /** Keep the shelf even at zero, with `empty` in place of its rows. "Nothing
   *  needs you" is an answer; a section that vanishes is a question about
   *  whether it was ever there. */
  empty?: string;
  /** Draw the count as a filled pill rather than plain text. For the one shelf
   *  whose number is a call to act — the rest are just how many there are. */
  badge?: boolean;
}) {
  if (!count && !empty) return null;
  return (
    <View style={pinned ? s.shelf : undefined}>
      <ShelfHeader label={label} count={count} open={open} onToggle={onToggle} badge={badge} />
      {open ? (
        !count && empty ? (
          <Text style={s.shelfEmpty}>{empty}</Text>
        ) : pinned ? (
          <ScrollView style={s.shelfScroll} contentContainerStyle={s.shelfList}>
            {children}
          </ScrollView>
        ) : (
          <View style={s.shelfList}>{children}</View>
        )
      ) : null}
    </View>
  );
}

/** A shelf's own row. Separate from Shelf because "Others" heads the
 *  virtualized list rather than wrapping children — a Shelf there would have to
 *  take the whole thread list as children and lose the recycling. */
function ShelfHeader({
  label,
  count,
  open,
  onToggle,
  badge,
}: {
  label: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  badge?: boolean;
}) {
  return (
    <Pressable onPress={onToggle} style={({ pressed }) => [s.shelfHeader, pressed && s.rowHover]}>
      <Ionicons name={open ? "chevron-down" : "chevron-forward"} size={11} color={COLOR.fgFaint} />
      <Text style={s.shelfLabel}>{label}</Text>
      {badge && count ? (
        <View style={s.shelfBadge}>
          <Text style={s.shelfBadgeText}>{count}</Text>
        </View>
      ) : (
        <Text style={s.shelfCount}>{count}</Text>
      )}
    </Pressable>
  );
}

function SectionHeader({
  label,
  trailing,
  action,
  strong,
}: {
  label: string;
  trailing?: string;
  /** A top-level heading rather than a group label — "Sessions" over its own
   *  cuts, which would otherwise read as a fourth sibling of them. */
  strong?: boolean;
  action?: {
    icon: React.ComponentProps<typeof Ionicons>["name"];
    hint: string;
    onPress: () => void;
  };
}) {
  return (
    <View style={s.sectionHeader}>
      <Text style={strong ? s.headingLabel : s.sectionLabel}>{label}</Text>
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
  hostChip,
  selected,
  onPress,
  onCompose,
}: {
  space: Space;
  hostChip: (hostId: string, fallback: string) => string | null;
  selected: boolean;
  onPress: () => void;
  /** Start a task already scoped to this project. */
  onCompose: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <Pressable
      onPress={onPress}
      onHoverIn={() => setHover(true)}
      onHoverOut={() => setHover(false)}
      style={({ pressed }) => [s.spaceRow, selected ? s.rowSelected : pressed && s.rowHover]}
    >
      {/* The folder IS the status light. A dot beside it said the same thing
          twice, and two marks competing at the leading edge is what made the
          row read as busy. Filled when the project wants you, hollow otherwise
          — shape carries the state as well as colour, so it survives a
          colourblind reader and a greyscale screenshot. */}
      <Ionicons
        name={space.attention > 0 ? "folder-open-outline" : "folder-outline"}
        size={13}
        color={space.attention > 0 ? COLOR.warning : space.live ? COLOR.accent : COLOR.fgFaint}
      />
      <Text numberOfLines={1} style={s.spaceName}>
        {space.name}
      </Text>
      {/* Compose at the TRAILING edge, where an action belongs — the leading
          icon is identity, not a button. It takes the host label's place on
          hover so the row keeps its width and the names stay aligned. */}
      <HoverSwap
        hover={hover}
        minWidth={13}
        resting={
          hostChip(space.hostId, space.host) ? (
            <Text numberOfLines={1} style={s.spaceHost}>
              @ {hostChip(space.hostId, space.host)}
            </Text>
          ) : null
        }
        action={
          <Pressable
            onPress={onCompose}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel={`New task in ${space.name}`}
            style={({ pressed }) => pressed && s.pressed60}
          >
            <Ionicons name="create-outline" size={13} color={COLOR.accent} />
          </Pressable>
        }
      />
    </Pressable>
  );
}

function SessionRow({
  session,
  project,
  hostChip,
  selected,
  onPress,
  onSettle,
  agentHue,
}: {
  session: Session;
  project: string;
  hostChip: (hostId: string, fallback: string) => string | null;
  selected: boolean;
  onPress: () => void;
  /** Absent when the thread is busy or blocked — those can't be settled. */
  onSettle?: () => void;
  /** Bound once by the list rather than per row — see `useAgentHex`. */
  agentHue: string;
}) {
  // Archived threads (worktree gone) are history — they stay readable but drop
  // back so the live list reads first.
  const dim = !session.isResumable;
  const [hover, setHover] = useState(false);
  const edgeFade = useHoverFade(hover);
  const busy = session.activity === "running" || session.activity === "streaming";
  const runStart = useRunStart(session.id, busy);
  return (
    <Pressable
      onPress={onPress}
      onHoverIn={() => setHover(true)}
      onHoverOut={() => setHover(false)}
      style={({ pressed }) => [s.sessionRow, selected ? s.rowSelected : pressed && s.rowHover]}
    >
      {/* The agent's colour on the leading edge, on hover only. Painted down
          every row at rest it was a column of stripes competing with the text
          for the same glance — the small square beside the project name already
          carries agent identity when you are reading. This is the pointer's
          echo: it says which thread you are about to open, and whose it is.
          Inset and rounded rather than a full-height rule, so it reads as a
          marker rather than a border on the row. */}
      <Animated.View
        pointerEvents="none"
        style={[
          s.sessionEdge,
          { backgroundColor: dim ? COLOR.fgFaint : agentHue, opacity: edgeFade },
        ]}
      />
      <View style={s.sessionCaptionRow}>
        {/* The agent's mark, in its own hue — the same colour as the edge, so
            the two read as one signal rather than two competing ones. */}
        <View style={[s.sessionGlyph, { backgroundColor: dim ? COLOR.fgFaint : agentHue }]} />
        <Text numberOfLines={1} style={[s.sessionCaption, dim && s.dimmed]}>
          {project}
        </Text>
        {/* The timestamp gives up its place on hover rather than the row growing
            a column that is empty most of the time. */}
        <HoverSwap
          hover={hover && !!onSettle}
          minWidth={13}
          resting={
            /* What it is doing, then for how long — a bare timestamp said only
               that something happened, and you had to open the thread to learn
               whether it was still going. */
            <View style={s.sessionStatus}>
              {busy ? (
                <RunningTag
                  label={
                    <>
                      Working{runStart ? " " : ""}
                      {runStart ? <TimeAgo iso={runStart} /> : null}
                    </>
                  }
                />
              ) : (
                <TimeAgo iso={session.updatedAt} style={s.sessionTime} />
              )}
            </View>
          }
          action={
            onSettle ? (
              <Pressable
                onPress={onSettle}
                hitSlop={6}
                accessibilityRole="button"
                accessibilityLabel={`Settle ${session.title}`}
                style={({ pressed }) => pressed && s.pressed60}
              >
                <Ionicons name="checkmark-circle-outline" size={13} color={COLOR.accent} />
              </Pressable>
            ) : null
          }
        />
      </View>
      <Text numberOfLines={1} style={[s.sessionTitle, dim && s.dimmed]}>
        {session.title}
      </Text>
      <View style={s.sessionMetaRow}>
        {/* Agent moved to the leading edge as colour, and live state to the
            status line — what is left here is WHERE the work is: which branch,
            on which machine. */}
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
        {/* Only when it says something: another machine, under the name you
            gave it. See hostChip. */}
        {hostChip(session.hostId, session.host) ? (
          <>
            <Ionicons name="desktop-outline" size={9} color={COLOR.fgFaint} />
            <Text numberOfLines={1} style={s.sessionHost}>
              {hostChip(session.hostId, session.host)}
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

/**
 * When did this thread's CURRENT run start?
 *
 * `session.updatedAt` bumps on every event the agent emits, so a "Working 7s"
 * measured from it reports time since the last tool call, not how long the agent
 * has been working — it visibly counts up and snaps back to zero every few
 * seconds. It was reporting the wrong quantity from the day the tag landed; the
 * live <TimeAgo/> only made it obvious.
 *
 * There is no turn-start timestamp on `Session` (only createdAt/updatedAt), so
 * this remembers the first moment we saw the thread busy. Two known limits, both
 * preferable to a counter that resets: a thread already running when the app
 * opens is timed from when this window first saw it, and a relaunch restarts the
 * count. A restart-proof version needs the host to report the turn's start.
 */
const runStartedAt = new Map<string, number>();
function useRunStart(id: string, busy: boolean): string | null {
  // Idempotent, so running it during render is safe: the same id and busy flag
  // always produce the same map state.
  if (!busy) {
    runStartedAt.delete(id);
    return null;
  }
  let started = runStartedAt.get(id);
  if (started === undefined) {
    started = Date.now();
    runStartedAt.set(id, started);
  }
  return new Date(started).toISOString();
}

/**
 * "Working 36s" — the tag a row wears while its agent is busy.
 *
 * The liveness is the tag's own slow breath rather than a spinning logo. A
 * spinner is a loop at a fixed speed: it says "busy" at the same pitch whether
 * one thread is running or eight, and eight of them in a list is a lot of
 * competing motion for a sidebar you are trying to read past. This is one
 * element easing between full and half opacity, which reads as alive at a
 * glance and as nothing at all in peripheral vision.
 *
 * The dashed border carries the same idea statically — an outline that hasn't
 * closed yet, for work that hasn't finished.
 */
// `label` is a node, not a string: it carries a live <TimeAgo/>, which has to
// keep itself current now that the sidebar no longer re-renders on every sync
// tick (see .claude/skills/render-once).
function RunningTag({ label }: { label: React.ReactNode }) {
  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const step = (toValue: number) =>
      Animated.timing(pulse, {
        toValue,
        duration: 1100,
        easing: Easing.inOut(Easing.quad),
        useNativeDriver: true,
      });
    const loop = Animated.loop(Animated.sequence([step(0.45), step(1)]));
    loop.start();
    // Stopped on unmount: a recycled LegendList row would otherwise leave the
    // animation running against a view that has moved on to another thread.
    return () => loop.stop();
  }, [pulse]);
  return (
    <Animated.View style={[s.runningTag, { opacity: pulse }]}>
      <Text style={s.runningTagText}>{label}</Text>
    </Animated.View>
  );
}

/**
 * A 0→1 value that follows a hover flag, on the shared timing.
 *
 * In is slower than out: something arriving wants to be noticed, something
 * leaving should already be gone by the time the eye follows the pointer to the
 * next row.
 */
function useHoverFade(hover: boolean): Animated.Value {
  const t = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(t, {
      toValue: hover ? 1 : 0,
      duration: hover ? 110 : 80,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();
  }, [hover, t]);
  return t;
}

/**
 * Crossfade between what a row shows at rest and the control that takes its
 * place on hover.
 *
 * Both stay mounted and stacked in one slot, so the row never reflows — the
 * same reason these swaps replace the timestamp or host label instead of adding
 * a column that would be empty most of the time. Mounting the control on hover
 * instead popped it in at full opacity, which reads as a flicker at the speed a
 * pointer crosses a list of rows.
 *
 * Out is quicker than in: a control arriving wants to be noticed, one leaving
 * should already be gone by the time the eye follows the pointer to the next
 * row. `pointerEvents` is tied to `hover`, not to the animation, so a click
 * landing during the fade still hits the control.
 */
function HoverSwap({
  hover,
  minWidth,
  resting,
  action,
}: {
  hover: boolean;
  /** Keeps the slot open when there is nothing at rest to hold it. */
  minWidth: number;
  resting: ReactNode;
  action: ReactNode;
}) {
  const t = useHoverFade(hover);
  const restOpacity = t.interpolate({ inputRange: [0, 1], outputRange: [1, 0] });
  return (
    <View style={[s.swapSlot, { minWidth }]}>
      <Animated.View style={{ opacity: restOpacity }}>{resting}</Animated.View>
      <Animated.View pointerEvents={hover ? "auto" : "none"} style={[s.swapAction, { opacity: t }]}>
        {action}
      </Animated.View>
    </View>
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
  /* The heading the shelves sit under. Bigger, brighter and in sentence case —
     the group labels stay small and faint so the hierarchy is visible without
     a rule or an indent. */
  headingLabel: { fontSize: 13, fontWeight: "700", color: theme.colors.fg },
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

  /** The stacked slot a HoverSwap fades within — sized by whichever of the two
   *  is wider, so neither state shifts the row. */
  swapSlot: { alignItems: "flex-end", justifyContent: "center" },
  swapAction: {
    position: "absolute",
    right: 0,
    top: 0,
    bottom: 0,
    alignItems: "flex-end",
    justifyContent: "center",
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
  /** The hover marker — see the note at the render site. Absolute, so it costs
   *  the row no layout and cannot shift the text when it appears. */
  sessionEdge: {
    position: "absolute",
    left: 0,
    top: 5,
    bottom: 5,
    width: 2.5,
    borderRadius: 999,
  },
  /** Right-hand status: what the thread is doing, not just when it last did it. */
  sessionStatus: { flexDirection: "row", alignItems: "center", gap: 4 },
  /** The busy tag. Dashed, in the accent, at the same size as the timestamp it
   *  replaces so the row's right edge does not jump between the two states. */
  runningTag: {
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: theme.colors.accentLine,
    borderRadius: 5,
    paddingHorizontal: 5,
    paddingVertical: 0.5,
  },
  runningTagText: { fontSize: 9.5, color: theme.colors.accent },
  /** The machine, at the end of the meta line. */
  sessionHost: { fontSize: 10, color: theme.colors.fgFaint },
  /** A count that has to be noticed — the attention shelf's badge. */
  shelfBadge: {
    minWidth: 15,
    paddingHorizontal: 4,
    borderRadius: 999,
    backgroundColor: theme.colors.warning,
    alignItems: "center",
    justifyContent: "center",
  },
  shelfBadgeText: { fontSize: 9.5, fontWeight: "700", color: theme.colors.onAccent },
  sessionCaptionRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  /** A small square in the agent's hue, leading the project name. */
  sessionGlyph: { height: 8, width: 8, borderRadius: 2.5 },
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

  /* Quieter than a session row and visibly unstarted: a draft carries no agent
     mark and no time, because nothing has happened to it yet. Its section
     header already says "Drafts", so the row doesn't repeat the word. */
  draftRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  draftTitle: { flex: 1, fontSize: 12.5, color: theme.colors.fgMuted },
  /* A SHELF: Drafts and Settled are the same shape — the two ends of the live
     list, pinned so neither has to be hunted for. One vocabulary rather than
     two, so they cannot drift apart. */
  shelf: {
    gap: 1,
    // Hairline, not 1pt: on a Retina display 1pt is two physical pixels, and
    // the Settled shelf's rule lands within about forty points of the account
    // row's — two heavy full-width lines stacked at the foot of the sidebar.
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
    paddingTop: 6,
    paddingBottom: 2,
  },
  /* Bounded: a hundred settled threads must not turn a shelf into the sidebar.
     Past this it scrolls on its own. */
  shelfScroll: { maxHeight: 220 },
  shelfList: { gap: 1, paddingBottom: 4 },
  shelfHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  shelfLabel: {
    flex: 1,
    fontSize: 11,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    color: theme.colors.fgFaint,
  },
  /* Destructive, so it reads as a word rather than hiding behind a glyph. */
  shelfAction: { fontSize: 11, fontWeight: "600", color: theme.colors.fgMuted },
  shelfEmpty: {
    paddingHorizontal: 14,
    paddingVertical: 4,
    fontSize: 11.5,
    color: theme.colors.fgFaint,
  },
  shelfCount: { fontFamily: "JetBrainsMono", fontSize: 11, color: theme.colors.fgFaint },
  /* Compact and quiet: settled rows are a record, not a feed. One line, no
     agent mark, no branch — everything that made the active row scannable is
     what would make this list compete with it. */
  settledRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  settledTitle: { flex: 1, fontSize: 12, color: theme.colors.fgMuted },
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
    // See the shelf's note — same reason, and these two are the pair.
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  accountHover: { backgroundColor: theme.colors.surface },
  statusDot: { height: 8, width: 8, borderRadius: 999 },
  statusDotOn: { backgroundColor: theme.colors.accent },
  // Connecting counts as offline here on purpose: this is a two-state light,
  // and a third colour mid-handshake would flicker on every reconnect.
  statusDotOff: { backgroundColor: theme.colors.surfaceHover },
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

  pressed60: { opacity: 0.6 },
  pressed70: { opacity: 0.7 },
}));
