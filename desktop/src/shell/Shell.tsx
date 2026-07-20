/**
 * Desktop shell — master-detail layout over the mobile screens.
 *
 * Left: dense thread sidebar (search, project groups, status footer).
 * Right: the selected session, or an empty state.
 * Overlay: every mobile modal route rendered as a centered card; git-heavy
 * surfaces (changes, terminal) get a wider card. Navigation state lives in the
 * router shim, so the reused screens drive this shell with their original
 * router calls.
 */
import type { ComponentType } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSelector } from "@legendapp/state/react";
import { Ionicons } from "@expo/vector-icons";
import { nav$, router, RouteParamsProvider } from "../shims/router";
import { COLOR } from "@pounce/app/ui";
import { T } from "@pounce/app/ui/theme";
import { Sidebar } from "./Sidebar";
import SessionScreen from "@pounce/app/screens/Session";
import SessionsScreen from "@pounce/app/screens/Sessions";
import SearchScreen from "@pounce/app/screens/Search";
import SettingsScreen from "@pounce/app/screens/Settings";
import NewTaskScreen from "@pounce/app/screens/New";
import ChangesScreen from "@pounce/app/screens/Changes";
import TerminalScreen from "@pounce/app/screens/Terminal";
import ConnectScreen from "@pounce/app/screens/Connect";
import HelpScreen from "@pounce/app/screens/Help";
import SyncHistoryScreen from "@pounce/app/screens/SyncHistory";
import DiagnosticsScreen from "@pounce/app/screens/Diagnostics";
import PairScreen from "../screens/Pair";

/** Modal cards need an explicit height: the screens inside are flex-1, so a
 *  content-sized card collapses to its minimum while centered children
 *  overflow past the header (the floating-QR bug). maxHeight in the host
 *  still clamps these on small windows. */
const MODALS: Record<string, { component: ComponentType; width: number; height: number }> = {
  "/search": { component: SearchScreen, width: 620, height: 560 },
  "/sessions": { component: SessionsScreen, width: 620, height: 660 },
  "/settings": { component: SettingsScreen, width: 620, height: 660 },
  "/new": { component: NewTaskScreen, width: 640, height: 660 },
  "/changes": { component: ChangesScreen, width: 860, height: 660 },
  "/terminal": { component: TerminalScreen, width: 860, height: 660 },
  "/connect": { component: ConnectScreen, width: 560, height: 460 },
  "/help": { component: HelpScreen, width: 620, height: 640 },
  "/sync-history": { component: SyncHistoryScreen, width: 620, height: 600 },
  "/diagnostics": { component: DiagnosticsScreen, width: 620, height: 620 },
  "/pair": { component: PairScreen, width: 560, height: 640 },
};

function EmptyState() {
  return (
    <View style={s.empty}>
      <Ionicons name="paw-outline" size={44} color={COLOR.fgFaint} />
      <Text style={s.emptyText}>Select a thread to follow along</Text>
      <Pressable
        onPress={() => router.push("/new")}
        style={({ pressed }) => [s.newTaskBtn, pressed && s.pressed80]}
      >
        <Ionicons name="add" size={16} color="#fff" />
        <Text style={s.newTaskLabel}>New task</Text>
      </Pressable>
      <Pressable
        onPress={() => router.push("/pair")}
        style={({ pressed }) => [s.pairLink, pressed && s.pressed70]}
      >
        <Text style={s.pairLinkText}>Pair your phone →</Text>
      </Pressable>
    </View>
  );
}

export function Shell() {
  const detail = useSelector(nav$.detail);
  const modal = useSelector(nav$.modal);
  const entry = modal ? MODALS[modal.path] : null;

  return (
    <View style={s.root}>
      <View style={s.sidebar}>
        <Sidebar />
      </View>

      <View style={s.detail}>
        {detail ? (
          <RouteParamsProvider key={detail.params.id ?? "detail"} params={detail.params}>
            <SessionScreen />
          </RouteParamsProvider>
        ) : (
          <EmptyState />
        )}
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
          </View>
        </View>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, flexDirection: "row", backgroundColor: T.bg },
  sidebar: { width: 300, borderRightWidth: 1, borderColor: T.border },
  detail: { flex: 1 },
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    backgroundColor: T.bg,
  },
  emptyText: { fontSize: 15, color: T.fgMuted },
  newTaskBtn: {
    marginTop: 4,
    height: 36,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 999,
    backgroundColor: T.accent,
    paddingHorizontal: 16,
  },
  newTaskLabel: { fontSize: 13, fontWeight: "600", color: T.onAccent },
  pairLink: { marginTop: 4 },
  pairLinkText: { fontSize: 12, color: T.fgFaint },
  pressed70: { opacity: 0.7 },
  pressed80: { opacity: 0.8 },
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
    borderColor: T.borderStrong,
    backgroundColor: T.bg,
  },
});
