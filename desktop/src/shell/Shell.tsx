/**
 * Desktop shell.
 *
 *   ┌──────────┬───────────────────────────────────────┐
 *   │ Sidebar  │ TabStrip                              │
 *   │ spaces   ├───────────────────────────────────────┤
 *   │ sessions │ StatusBar (checkout · usage · branch) │
 *   │ account  ├────────────────────────┬──────────────┤
 *   │          │ session transcript     │ changes dock │
 *   └──────────┴────────────────────────┴──────────────┘
 *
 * The window has no system title bar (AppDelegate makes it transparent and
 * full-size), so the sidebar's top row and the tab strip are the chrome — both
 * are drag regions. Everything else is a centered modal card, as before; the
 * screens still navigate with their original router hrefs and the shim maps
 * them onto this layout.
 */
import { useRef, useState, type ComponentType } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useSelector } from "@legendapp/state/react";
import { Ionicons } from "@expo/vector-icons";
import { nav$, RouteParamsProvider, screenKey } from "../shims/router";
import { COLOR } from "@pounce/app/ui";
import { useThread } from "@pounce/app/state/db/hooks";
import { sessionChrome$ } from "@pounce/app/state/sessionChrome";
import { ThreadUsageSummary } from "@pounce/app/components/ThreadStatusBar";
import { AccessAlert } from "./AccessAlert";
import { Sidebar } from "./Sidebar";
import { TabStrip } from "./TabStrip";
import { OpenInMenu } from "./OpenIn";
import { ThemeMenu } from "./ThemeMenu";
import { TerminalDock, isTermOpen, toggleTerm } from "./TerminalDock";
import { DiffDock, DOCK_HIDE_BELOW } from "./DiffDock";
import { Splitter, SPLITTER_WIDTH } from "./Splitter";
import { reportWindowHeight } from "./fullscreen";
import { CrossFade } from "./Motion";
import {
  MIN_TRANSCRIPT_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from "./metrics";
import SessionScreen from "@pounce/app/screens/Session";
import SessionsScreen from "@pounce/app/screens/Sessions";
import SearchScreen from "@pounce/app/screens/Search";
import SettingsScreen from "@pounce/app/screens/Settings";
import SettingsDevicesScreen from "@pounce/app/screens/settings/Devices";
import SettingsAppearanceScreen from "@pounce/app/screens/settings/Appearance";
import SettingsSpendScreen from "@pounce/app/screens/settings/Spend";
import DashboardScreen from "@pounce/app/screens/Dashboard";
import NewTaskScreen from "@pounce/app/screens/New";
import ContextScreen from "@pounce/app/screens/Context";
import TerminalScreen from "@pounce/app/screens/Terminal";
import ConnectScreen from "@pounce/app/screens/Connect";
import HelpScreen from "@pounce/app/screens/Help";
import SyncHistoryScreen from "@pounce/app/screens/SyncHistory";
import DiagnosticsScreen from "@pounce/app/screens/Diagnostics";
import PairScreen from "../screens/Pair";
import PeersScreen from "../screens/Peers";
import AddMachineScreen from "../screens/AddMachine";
import AccessScreen from "../screens/Access";
import SpaceScreen from "@pounce/app/screens/Space";
import MetricScreen from "@pounce/app/screens/Metric";
import { FilterSheetContent } from "@pounce/app/components/FilterSheet";
import { SETTINGS_ROUTES, settingsHref } from "@pounce/app/screens/settings/routes";

/** The settings sub-screens as modal entries — titles and sizes come from the
 *  manifest the mobile stack also reads, so the two can't disagree. */
const SETTINGS_SCREENS: Record<string, ComponentType> = {
  devices: SettingsDevicesScreen,
  appearance: SettingsAppearanceScreen,
  spend: SettingsSpendScreen,
};

function settingsModals(): Record<string, ModalEntry> {
  return Object.fromEntries(
    SETTINGS_ROUTES.map((r) => [
      settingsHref(r.name),
      { component: SETTINGS_SCREENS[r.name], width: r.width, height: r.height, title: r.title },
    ]),
  );
}

/** Filters as a routed modal card (same href as mobile) — the shared sheet
 *  body with the shell's standard scrim/card instead of a phone bottom sheet. */
function FiltersModal() {
  return (
    <ScrollView
      style={s.filtersBody}
      contentContainerStyle={{ gap: 16, paddingBottom: 32 }}
      keyboardShouldPersistTaps="handled"
    >
      <FilterSheetContent onClose={() => nav$.modal.set(null)} />
    </ScrollView>
  );
}

/** Modal cards need an explicit height: the screens inside are flex-1, so a
 *  content-sized card collapses to its minimum while centered children
 *  overflow past the header (the floating-QR bug). maxHeight in the host
 *  still clamps these on small windows.
 *
 *  /changes is absent by design — it's the docked pane now (see the shim). */
/** Screens that fill the detail pane under their own tab (see the shim's
 *  PANES). They're places, not dialogs — a modal card would be the wrong
 *  container for a page you read, edit, and come back to. */
const PANE_SCREENS: Record<string, ComponentType> = {
  "/space": SpaceScreen,
  "/metric": MetricScreen,
  "/settings": SettingsScreen,
  "/new": NewTaskScreen,
};

/**
 * A modal card: the screen, its size, and — when the HOST should draw the
 * chrome — a title and the word its dismiss control uses.
 *
 * `title` is what makes the header the host's job. Every screen used to draw
 * its own `IS_DESKTOP` title row, so the same header existed five times over and
 * a sixth control (a floating ✕) had to float above them all because they
 * disagreed. Screens that own their header deliberately (Diagnostics carries a
 * Refresh action in it) simply have no title here and keep drawing it.
 *
 * The dismiss WORD is per modal, not a constant: abandoning a half-written task
 * is "Cancel", closing something you were only reading is "Done".
 */
interface ModalEntry {
  component: ComponentType;
  width: number;
  height: number;
  title?: string;
  dismissLabel?: string;
}

const MODALS: Record<string, ModalEntry> = {
  "/search": { component: SearchScreen, width: 620, height: 560 },
  "/sessions": { component: SessionsScreen, width: 620, height: 660 },
  // Wider than the list modals: the heatmap is ~700px of grid at its cell size.
  "/activity": { component: DashboardScreen, width: 760, height: 700 },
  "/context": {
    component: ContextScreen,
    width: 720,
    height: 700,
    title: "Project context",
    dismissLabel: "Close",
  },
  "/terminal": { component: TerminalScreen, width: 860, height: 660 },
  "/connect": { component: ConnectScreen, width: 560, height: 460 },
  "/help": { component: HelpScreen, width: 620, height: 640, title: "Help" },
  "/sync-history": {
    component: SyncHistoryScreen,
    width: 620,
    height: 600,
    title: "Sync history",
  },
  // Settings' sub-screens, from the shared manifest — the Settings pane stays a
  // tab you sit in; each of these is one job you finish and dismiss, which is
  // what a card is for.
  ...settingsModals(),
  "/diagnostics": { component: DiagnosticsScreen, width: 620, height: 620 },
  "/pair": { component: PairScreen, width: 560, height: 640 },
  // Taller than /pair: both are step-by-step and the catalog picker needs room
  // for a space list and a search result list at the same time.
  "/peers": { component: PeersScreen, width: 600, height: 680 },
  // Shorter than /peers: a form, a status line and a log — no lists to browse.
  "/add-machine": { component: AddMachineScreen, width: 600, height: 620 },
  "/access": { component: AccessScreen, width: 600, height: 680 },
  "/filters": { component: FiltersModal, width: 560, height: 660 },
};

/** Where the open thread actually lives — the desktop equivalent of a title
 *  bar's proxy icon. Quiet by default; it's reference, not navigation. */
function StatusBar({ threadId }: { threadId: string }) {
  const session = useThread(threadId);
  // Published by the open session (it does the fetching); shown here because
  // the pane has no header of its own to put it in.
  const usage = useSelector(() => sessionChrome$.usage.get());
  if (!session) return null;
  return (
    <View style={s.statusBar}>
      <Ionicons
        name={session.worktree ? "git-network-outline" : "folder-open-outline"}
        size={11}
        color={COLOR.fgFaint}
      />
      {/* The one place desktop shows where a thread lives — so it has to be
          copyable. No Pressable above it, so selection is safe here. */}
      <Text selectable numberOfLines={1} style={s.statusPath}>
        {session.worktree ? "Worktree" : "Local checkout"}
        {session.cwd ? ` · ${session.cwd.replace(/^\/Users\/[^/]+/, "~")}` : ""}
      </Text>
      <View style={s.flex1} />
      {/* The checklist toggle used to live here. It moved into the composer's
          pill row (shared Composer), next to the markers pill — one control in
          one place on every platform, rather than a chip up here and an
          identical pill down there. */}
      <ThreadUsageSummary usage={usage} />
      {session.branch ? (
        <>
          <Ionicons name="git-branch-outline" size={11} color={COLOR.fgFaint} />
          <Text selectable numberOfLines={1} style={s.statusBranch}>
            {session.branch}
          </Text>
        </>
      ) : null}
    </View>
  );
}

/** Modifiers spelled out in full — see enrichedInput.desktop.tsx for why an
 *  omitted one means "don't care" under Fabric and would swallow ⌘` too. */
const TERM_SHORTCUT = [{ key: "`", ctrlKey: true, shiftKey: false, altKey: false, metaKey: false }];

export function Shell() {
  const detail = useSelector(nav$.detail);
  const modal = useSelector(nav$.modal);
  const dock = useSelector(nav$.dock);
  const sidebar = useSelector(nav$.sidebar);
  const entry = modal ? MODALS[modal.path] : null;
  const Pane = detail ? PANE_SCREENS[detail.path] : undefined;
  // Only a SESSION tab has a thread. A pane tab has none, and the chrome that
  // describes the open thread (status bar, diff dock) must go quiet for it
  // rather than keep describing whatever was open before.
  const threadId = detail && !Pane ? (detail.params.id ?? null) : null;
  // The dock needs the thread's machine and folder, which only the record has.
  const termThread = useThread(threadId ?? undefined);
  const termOpen = useSelector(() => isTermOpen(threadId));
  const [shellWidth, setShellWidth] = useState(0);
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT_WIDTH);
  const sidebarStart = useRef(SIDEBAR_DEFAULT_WIDTH);

  // What the dock may take: everything left over once the sidebar and a
  // readable transcript have theirs. Want a wider diff than that allows? Drag
  // the sidebar in — it's never taken away automatically.
  const dockMax = Math.max(
    DOCK_HIDE_BELOW,
    shellWidth - (sidebar ? sidebarWidth : 0) - MIN_TRANSCRIPT_WIDTH,
  );

  return (
    // The dock sizes itself against the shell's real width — Dimensions reports
    // the screen, not this window, so anything derived from it is wrong the
    // moment the window isn't full-screen.
    <View
      style={s.root}
      onLayout={(e) => {
        setShellWidth(e.nativeEvent.layout.width);
        // The window's real content height — Dimensions reports the screen on
        // this platform, so the chrome can only learn this from here.
        reportWindowHeight(e.nativeEvent.layout.height);
      }}
      // ⌃` toggles the terminal — the convention every editor uses. Handled on
      // the window root rather than by a menu item so it works wherever focus
      // is; a focused text field consumes its own keys first, which is why the
      // dock's key sink deliberately does NOT claim this combination.
      {...({
        keyDownEvents: TERM_SHORTCUT,
        onKeyDown: (e: { nativeEvent?: { key?: string; ctrlKey?: boolean } }) => {
          if (e?.nativeEvent?.key === "`" && e.nativeEvent.ctrlKey) toggleTerm(threadId);
        },
      } as Record<string, unknown>)}
    >
      {sidebar ? (
        <>
          <View style={[s.sidebar, { width: sidebarWidth }]}>
            <Sidebar />
          </View>
          {/* Straddles the seam instead of occupying a column: as a sibling it
              was a 14pt band of flat window background between the sidebar's
              vibrancy and the content pane, which read as a black stripe. With
              no layout width the two panes meet, and the grab strip floats over
              the join. */}
          <Splitter
            style={[s.sidebarSplitter, { left: sidebarWidth - SPLITTER_WIDTH / 2 }]}
            onStart={() => {
              sidebarStart.current = sidebarWidth;
            }}
            onMove={(dx) =>
              setSidebarWidth(
                Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, sidebarStart.current + dx)),
              )
            }
          />
        </>
      ) : null}

      <View style={s.main}>
        <TabStrip />
        {/* Directly under the tab strip, so the checkout reads as belonging to
            the tab above it rather than to the window. Tab strip and status bar
            share one hairline underneath — two stacked rules would make this a
            wall of chrome. */}
        {threadId ? <StatusBar threadId={threadId} /> : null}
        <View style={s.panes}>
          {/* Switching tabs replaces the transcript in place; a short fade
              makes that read as a change of view rather than a flicker. */}
          {/* Keyed by SCREEN identity, which is finer than the tab's: the one
              Space tab changes `key` in place as you move between projects, and
              keying on the tab alone would leave the previous project mounted. */}
          <CrossFade key={detail ? screenKey(detail) : "empty"} style={s.detail}>
            {detail && Pane ? (
              <RouteParamsProvider key={screenKey(detail)} params={detail.params}>
                <Pane />
              </RouteParamsProvider>
            ) : detail ? (
              <RouteParamsProvider key={threadId ?? "detail"} params={detail.params}>
                <SessionScreen />
              </RouteParamsProvider>
            ) : (
              // No thread open? Show Activity rather than a placeholder. The
              // pane is the size of a window here, and "what have my agents
              // been doing" is the useful thing to land on — a paw and a
              // sentence is what you show on a phone, where there's no room
              // for anything better.
              <DashboardScreen />
            )}
          </CrossFade>
          {dock && threadId && shellWidth > 0 ? (
            <DiffDock threadId={threadId} maxWidth={dockMax} />
          ) : null}
          {/* Someone at the door. Lives INSIDE the pane rather than at the
              window root: the root's children are the sidebar and main column,
              and an absolute sibling of those did not paint above them on
              macOS Fabric — it also would have landed in the transparent
              titlebar, on top of the traffic lights. Here it is unambiguously
              over the content, still absolute (so nothing reflows) and still
              box-none (so clicks fall through). Never a modal — see
              AccessAlert for why taking the keyboard is the worse failure. */}
          <AccessAlert />
        </View>
        {/* Full width under BOTH panes: a shell is about the checkout, not
            about the transcript, so boxing it under one column would make it
            look like part of the conversation. */}
        {termOpen && threadId && termThread ? (
          <TerminalDock
            key={threadId}
            threadId={threadId}
            hostId={termThread.hostId}
            // `cwd` is the path; `worktree` is a NAME ("v2"), which the status
            // bar uses only to choose between "Worktree" and "Local checkout".
            // Passing it as a directory sent the shell a relative string that
            // existed nowhere, so the bridge fell back to the home folder.
            cwd={termThread.cwd}
          />
        ) : null}
      </View>

      {/* Above the panes, below the modal host: a menu has to escape the tab
          strip it's anchored to, but must never cover a modal. */}
      <OpenInMenu />
      <ThemeMenu />

      {modal && entry ? (
        <View style={s.modalHost}>
          <Pressable style={s.modalScrim} onPress={() => nav$.modal.set(null)} />
          <View
            style={[s.modalCard, { width: entry.width, height: entry.height, maxHeight: "88%" }]}
          >
            {entry.title ? (
              <View style={s.modalHeader}>
                <Text style={s.modalTitle}>{entry.title}</Text>
                <Pressable
                  onPress={() => nav$.modal.set(null)}
                  style={({ pressed }) => pressed && s.pressed60}
                >
                  <Text style={s.modalDismiss}>{entry.dismissLabel ?? "Done"}</Text>
                </Pressable>
              </View>
            ) : null}
            <RouteParamsProvider
              key={`${modal.path}:${JSON.stringify(modal.params)}`}
              params={modal.params}
            >
              <entry.component />
            </RouteParamsProvider>
            {/* Screens that draw their own header (see ModalEntry) get the
                floating ✕ instead — several have no dismiss control of their
                own, because on a phone you swipe the sheet away. */}
            {entry.title ? null : (
              <Pressable
                onPress={() => nav$.modal.set(null)}
                accessibilityLabel="Close"
                style={({ pressed }) => [s.modalClose, pressed && s.modalClosePressed]}
              >
                <Ionicons name="close" size={14} color={COLOR.fgMuted} />
              </Pressable>
            )}
          </View>
        </View>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create((theme) => ({
  root: { flex: 1, flexDirection: "row", backgroundColor: theme.colors.bg },
  // No right border: the splitter floating over the seam draws it.
  sidebar: {},
  sidebarSplitter: { position: "absolute", top: 0, bottom: 0, zIndex: 5 },
  main: { flex: 1 },
  panes: { flex: 1, flexDirection: "row" },
  detail: { flex: 1 },
  flex1: { flex: 1 },
  statusBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    // Rule below, not above: it separates the chrome block (tabs + status) from
    // the transcript, and the tab strip needs no second line under it.
    borderBottomWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  statusChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    height: 17,
    borderRadius: 5,
    paddingHorizontal: 5,
  },
  statusChipOn: { backgroundColor: theme.colors.accentSoft },
  statusChipText: { fontSize: 10, color: theme.colors.fgFaint, fontVariant: ["tabular-nums"] },
  statusChipTextOn: { color: theme.colors.accent },
  statusPath: { flexShrink: 1, fontSize: 10.5, color: theme.colors.fgFaint },
  statusBranch: {
    flexShrink: 1,
    fontFamily: "JetBrainsMono",
    fontSize: 10.5,
    color: theme.colors.fgFaint,
  },
  modalHost: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    // Above the sidebar splitter, which is an absolutely-positioned SIBLING
    // with its own zIndex — without one here the modal defaults to 0 and the
    // grab strip draws a bar straight down the scrim and over the sheet.
    zIndex: 10,
  },
  modalScrim: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: theme.colors.overlay,
  },
  modalCard: {
    overflow: "hidden",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    // Raised off the scrim, like a real sheet — bg would match the window
    // behind it and the card would read as a hole rather than a panel.
    backgroundColor: theme.colors.bgElevated,
    shadowColor: "#000",
    shadowOpacity: 0.35,
    shadowRadius: 30,
    shadowOffset: { width: 0, height: 12 },
  },
  // The host's title row — one header for every modal that doesn't insist on
  // drawing its own. Metrics match what the five screens each used to repeat.
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 10,
  },
  modalTitle: { fontSize: 22, fontWeight: "700", color: theme.colors.fg },
  modalDismiss: { fontSize: 15, color: theme.colors.fgMuted },
  modalClose: {
    position: "absolute",
    top: 10,
    right: 10,
    height: 24,
    width: 24,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 999,
  },
  modalClosePressed: { backgroundColor: theme.colors.surfaceHover },
  pressed60: { opacity: 0.6 },
  // Inherits the card's surface: a second fill here made the body a grey slab
  // sitting inside a white card.
  // paddingTop clears the close button this shell floats over every modal
  // (top:10, 24pt tall → occupies down to 34pt). The filters sheet is the one
  // whose own header carries a right-aligned control ("Clear all"), so without
  // the reserved band the × lands on top of that label.
  filtersBody: { flex: 1, paddingHorizontal: 16, paddingTop: 40 },
}));
