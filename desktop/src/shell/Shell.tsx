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
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSelector } from "@legendapp/state/react";
import { Ionicons } from "@expo/vector-icons";
import { nav$, RouteParamsProvider, screenKey } from "../shims/router";
import { COLOR } from "@pounce/app/ui";
import { T } from "@pounce/app/ui/theme";
import { useThread } from "@pounce/app/state/db/hooks";
import { sessionChrome$ } from "@pounce/app/state/sessionChrome";
import { ThreadUsageSummary } from "@pounce/app/components/ThreadStatusBar";
import { Sidebar } from "./Sidebar";
import { TabStrip } from "./TabStrip";
import { DiffDock, DOCK_HIDE_BELOW } from "./DiffDock";
import { Splitter, SPLITTER_WIDTH } from "./Splitter";
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
import DashboardScreen from "@pounce/app/screens/Dashboard";
import NewTaskScreen from "@pounce/app/screens/New";
import ContextScreen from "@pounce/app/screens/Context";
import TerminalScreen from "@pounce/app/screens/Terminal";
import ConnectScreen from "@pounce/app/screens/Connect";
import HelpScreen from "@pounce/app/screens/Help";
import SyncHistoryScreen from "@pounce/app/screens/SyncHistory";
import DiagnosticsScreen from "@pounce/app/screens/Diagnostics";
import PairScreen from "../screens/Pair";
import SpaceScreen from "@pounce/app/screens/Space";
import MetricScreen from "@pounce/app/screens/Metric";
import { FilterSheetContent } from "@pounce/app/components/FilterSheet";

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
};

const MODALS: Record<string, { component: ComponentType; width: number; height: number }> = {
  "/search": { component: SearchScreen, width: 620, height: 560 },
  "/sessions": { component: SessionsScreen, width: 620, height: 660 },
  "/settings": { component: SettingsScreen, width: 620, height: 660 },
  // Wider than the list modals: the heatmap is ~700px of grid at its cell size.
  "/activity": { component: DashboardScreen, width: 760, height: 700 },
  "/new": { component: NewTaskScreen, width: 640, height: 660 },
  "/context": { component: ContextScreen, width: 720, height: 700 },
  "/terminal": { component: TerminalScreen, width: 860, height: 660 },
  "/connect": { component: ConnectScreen, width: 560, height: 460 },
  "/help": { component: HelpScreen, width: 620, height: 640 },
  "/sync-history": { component: SyncHistoryScreen, width: 620, height: 600 },
  "/diagnostics": { component: DiagnosticsScreen, width: 620, height: 620 },
  "/pair": { component: PairScreen, width: 560, height: 640 },
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
      <Text numberOfLines={1} style={s.statusPath}>
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
          <Text numberOfLines={1} style={s.statusBranch}>
            {session.branch}
          </Text>
        </>
      ) : null}
    </View>
  );
}

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
    <View style={s.root} onLayout={(e) => setShellWidth(e.nativeEvent.layout.width)}>
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
        </View>
      </View>

      {modal && entry ? (
        <View style={s.modalHost}>
          <Pressable style={s.modalScrim} onPress={() => nav$.modal.set(null)} />
          <View
            style={[s.modalCard, { width: entry.width, height: entry.height, maxHeight: "88%" }]}
          >
            <RouteParamsProvider
              key={`${modal.path}:${JSON.stringify(modal.params)}`}
              params={modal.params}
            >
              <entry.component />
            </RouteParamsProvider>
            {/* One close affordance for every modal, floated over the screen's
                own header — the reused mobile screens each draw their titles
                differently, and several have no dismiss control at all because
                on a phone you swipe the sheet away. */}
            <Pressable
              onPress={() => nav$.modal.set(null)}
              accessibilityLabel="Close"
              style={({ pressed }) => [s.modalClose, pressed && s.modalClosePressed]}
            >
              <Ionicons name="close" size={14} color={COLOR.fgMuted} />
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, flexDirection: "row", backgroundColor: T.bg },
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
    borderColor: T.border,
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
  statusChipOn: { backgroundColor: T.accentSoft },
  statusChipText: { fontSize: 10, color: T.fgFaint, fontVariant: ["tabular-nums"] },
  statusChipTextOn: { color: T.accent },
  statusPath: { flexShrink: 1, fontSize: 10.5, color: T.fgFaint },
  statusBranch: { flexShrink: 1, fontFamily: "JetBrainsMono", fontSize: 10.5, color: T.fgFaint },
  modalHost: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  modalScrim: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: T.overlay,
  },
  modalCard: {
    overflow: "hidden",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: T.border,
    // Raised off the scrim, like a real sheet — bg would match the window
    // behind it and the card would read as a hole rather than a panel.
    backgroundColor: T.bgElevated,
    shadowColor: "#000",
    shadowOpacity: 0.35,
    shadowRadius: 30,
    shadowOffset: { width: 0, height: 12 },
  },
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
  modalClosePressed: { backgroundColor: T.surfaceHover },
  // Inherits the card's surface: a second fill here made the body a grey slab
  // sitting inside a white card.
  filtersBody: { flex: 1, paddingHorizontal: 16, paddingTop: 12 },
});
