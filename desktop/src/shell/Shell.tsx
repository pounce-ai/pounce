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
import { Pressable, Text, View } from "react-native";
import { useSelector } from "@legendapp/state/react";
import { Ionicons } from "@expo/vector-icons";
import { nav$, router, RouteParamsProvider } from "../shims/router";
import { COLOR } from "@litter/app/ui";
import { Sidebar } from "./Sidebar";
import SessionScreen from "@litter/app/screens/Session";
import SearchScreen from "@litter/app/screens/Search";
import SettingsScreen from "@litter/app/screens/Settings";
import NewTaskScreen from "@litter/app/screens/New";
import ChangesScreen from "@litter/app/screens/Changes";
import TerminalScreen from "@litter/app/screens/Terminal";
import ConnectScreen from "@litter/app/screens/Connect";
import HelpScreen from "@litter/app/screens/Help";
import SyncHistoryScreen from "@litter/app/screens/SyncHistory";
import PairScreen from "../screens/Pair";

/** Modal cards need an explicit height: the screens inside are flex-1, so a
 *  content-sized card collapses to its minimum while centered children
 *  overflow past the header (the floating-QR bug). maxHeight in the host
 *  still clamps these on small windows. */
const MODALS: Record<string, { component: ComponentType; width: number; height: number }> = {
  "/search": { component: SearchScreen, width: 620, height: 560 },
  "/settings": { component: SettingsScreen, width: 620, height: 660 },
  "/new": { component: NewTaskScreen, width: 640, height: 660 },
  "/changes": { component: ChangesScreen, width: 860, height: 660 },
  "/terminal": { component: TerminalScreen, width: 860, height: 660 },
  "/connect": { component: ConnectScreen, width: 560, height: 460 },
  "/help": { component: HelpScreen, width: 620, height: 640 },
  "/sync-history": { component: SyncHistoryScreen, width: 620, height: 600 },
  "/pair": { component: PairScreen, width: 560, height: 640 },
};

function EmptyState() {
  return (
    <View className="flex-1 items-center justify-center gap-3 bg-bg">
      <Ionicons name="paw-outline" size={44} color={COLOR.fgFaint} />
      <Text className="text-[15px] text-fg-muted">Select a thread to follow along</Text>
      <Pressable
        onPress={() => router.push("/new")}
        className="active:opacity-80 mt-1 h-9 flex-row items-center gap-1.5 rounded-full bg-accent px-4"
      >
        <Ionicons name="add" size={16} color="#fff" />
        <Text className="text-[13px] font-semibold text-white">New task</Text>
      </Pressable>
      <Pressable onPress={() => router.push("/pair")} className="active:opacity-70 mt-1">
        <Text className="text-[12px] text-fg-faint">Pair your phone →</Text>
      </Pressable>
    </View>
  );
}

export function Shell() {
  const detail = useSelector(nav$.detail);
  const modal = useSelector(nav$.modal);
  const entry = modal ? MODALS[modal.path] : null;

  return (
    <View className="flex-1 flex-row bg-bg">
      <View style={{ width: 300 }} className="border-r border-border">
        <Sidebar />
      </View>

      <View className="flex-1">
        {detail ? (
          <RouteParamsProvider key={detail.params.id ?? "detail"} params={detail.params}>
            <SessionScreen />
          </RouteParamsProvider>
        ) : (
          <EmptyState />
        )}
      </View>

      {modal && entry ? (
        <View className="absolute inset-0 items-center justify-center">
          <Pressable
            className="absolute inset-0 bg-black/60"
            onPress={() => nav$.modal.set(null)}
          />
          <View
            style={{ width: entry.width, height: entry.height, maxHeight: "88%" }}
            className="overflow-hidden rounded-xl border border-border-strong bg-bg"
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
