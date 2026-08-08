/**
 * Session tabs across the top of the detail pane.
 *
 * Threads are long-lived and you jump between them constantly — a browser tab
 * strip is the shape people already know for that. Only the active tab's screen
 * is mounted (each session polls its host, so N mounted transcripts is N times
 * the traffic); the strip just remembers what's open.
 *
 * Doubles as the window's drag region: with the unified titlebar there is no
 * system title bar left to grab.
 */
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSelector } from "@legendapp/state/react";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { AgentStatusIcon, COLOR } from "@pounce/app/ui";
import { T } from "@pounce/app/ui/theme";
import { DragRegion, TITLEBAR_INSET } from "@pounce/app/ui/native/DragRegion";
import { useTrafficLightInset } from "./fullscreen";
import { useFavThreadSet, useProjectNames, useThreads } from "@pounce/app/state/db/hooks";
import { toggleFavThread } from "@pounce/app/state/stores";
import type { MetricKey } from "@pounce/app/screens/Metric";
import { sessionChrome$ } from "@pounce/app/state/sessionChrome";
import { closeTab, nav$, selectTab, tabKey, type Route } from "../shims/router";
import { SidebarGlyph } from "./icons";

/**
 * Icon per non-session tab — a page rather than a thread.
 *
 * This map is also what DECIDES a tab is a page: `activeIsSession` and the
 * label both key off it. Adding a pane to the shell's PANE_SCREENS without
 * adding it here doesn't just cost an icon — the tab falls through to the
 * thread branch, looks up a session id it doesn't have, and renders the
 * fallback title. That is how Settings came to be labelled "Thread", complete
 * with a thread's favourite and search controls beside it.
 */
const PANE_ICON: Record<string, React.ComponentProps<typeof Ionicons>["name"]> = {
  "/space": "folder-outline",
  "/metric": "stats-chart-outline",
  "/settings": "settings-outline",
};

/** Display name for a `/metric` tab. Deliberately terser than the page's own
 *  title ("Spend" vs "Estimated spend") because a tab is a few characters wide,
 *  but keyed by MetricKey so a new metric is a type error here rather than a
 *  tab silently labelled "Metric". */
const METRIC_LABEL: Record<MetricKey, string> = {
  tokens: "Tokens",
  spend: "Spend",
  sessions: "Sessions",
  messages: "Messages",
};

/** Display name for a `/space` tab, from its `repoId hostId` key. Falls back to
 *  the bare repo id so a tab still reads sensibly while projects are syncing. */
function spaceLabel(key: string | undefined, names: Record<string, string>): string {
  const repoId = (key ?? "").split(" ")[0];
  return names[repoId] ?? repoId.replace(/^repo:/, "") ?? "Space";
}

export function TabStrip() {
  const router = useRouter();
  const tabs = useSelector(() => nav$.tabs.get());
  const active = useSelector(() => nav$.active.get());
  const dock = useSelector(() => nav$.dock.get());
  const sidebar = useSelector(() => nav$.sidebar.get());
  const searchOpen = useSelector(() => sessionChrome$.searchOpen.get());
  const threads = useThreads();
  const projectNames = useProjectNames();
  const favSet = useFavThreadSet();
  // A pane tab (a Space) is a page, not a thread — the thread controls below
  // would be describing a tab that isn't open any more.
  const activeIsSession = !!tabs[active] && !PANE_ICON[tabs[active].path];
  const activeId = (activeIsSession ? tabs[active]?.params.id : null) ?? null;
  const isFav = !!activeId && favSet.has(activeId);
  const trafficLightInset = useTrafficLightInset();

  return (
    <View
      style={[
        s.root,
        // With the sidebar hidden the traffic lights float over this strip
        // instead, so the tabs have to start clear of them — except in full
        // screen, where there are none (see useTrafficLightInset).
        !sidebar && { paddingLeft: trafficLightInset },
      ]}
    >
      {/* Behind everything: bare strip = window drag. Must stay the FIRST child
          so every control below is painted above it and keeps its clicks. */}
      <DragRegion style={StyleSheet.absoluteFill} />
      {!sidebar ? (
        <Pressable
          onPress={() => nav$.sidebar.set(true)}
          accessibilityLabel="Show sidebar"
          style={({ pressed }) => [s.iconBtn, pressed && s.hover]}
        >
          <SidebarGlyph color={COLOR.fgMuted} filled={false} />
        </Pressable>
      ) : null}

      {tabs.map((tab: Route, i) => {
        const id = tab.params.id;
        const paneIcon = PANE_ICON[tab.path];
        const session = paneIcon ? undefined : threads.find((t) => t.id === id);
        // A Space tab is named after its project. The key encodes `repoId
        // hostId`, so the display name comes from the same projects collection
        // the sidebar reads — never a raw `repo:foo` id.
        const paneLabel = !paneIcon
          ? null
          : tab.path === "/metric"
            ? (METRIC_LABEL[tab.params.key as MetricKey] ?? "Metric")
            : tab.path === "/settings"
              ? "Settings"
              : spaceLabel(tab.params.key, projectNames);
        return (
          <Pressable
            key={tabKey(tab)}
            onPress={() => selectTab(i)}
            style={({ pressed }) => [s.tab, i === active ? s.tabActive : pressed && s.hover]}
          >
            {/* Always animated, including the active tab: with the session
                header gone this glyph is the only place the thread's live state
                is shown. */}
            {paneIcon ? (
              <Ionicons name={paneIcon} size={11} color={i === active ? COLOR.fg : COLOR.fgMuted} />
            ) : session ? (
              <AgentStatusIcon agent={session.agent} activity={session.activity} size={11} />
            ) : (
              <View style={s.tabDotFallback} />
            )}
            <Text numberOfLines={1} style={[s.tabLabel, i === active && s.tabLabelActive]}>
              {paneLabel ?? session?.title ?? "Thread"}
            </Text>
            <Pressable
              onPress={() => closeTab(i)}
              accessibilityLabel="Close tab"
              hitSlop={4}
              style={({ pressed }) => [s.tabClose, pressed && s.hover]}
            >
              <Ionicons name="close" size={11} color={COLOR.fgFaint} />
            </Pressable>
          </Pressable>
        );
      })}

      <Pressable
        onPress={() => router.push("/new")}
        accessibilityLabel="New task"
        style={({ pressed }) => [s.iconBtn, pressed && s.hover]}
      >
        <Ionicons name="add" size={15} color={COLOR.fgMuted} />
      </Pressable>

      {/* Empty middle: the strip's drag surface. */}
      <View style={s.flex1} />

      {/* The open session's own controls, which used to sit in a header inside
          the pane. Only meaningful with a session open. */}
      {activeIsSession ? (
        <>
          {/* Favourite is a toggle, not a menu item — it belongs where you can
              hit it in one click. Absent for new_* threads, which have no
              daemon id to favourite yet. */}
          {activeId && !activeId.startsWith("new_") ? (
            <Pressable
              onPress={() => toggleFavThread(activeId)}
              accessibilityLabel={isFav ? "Remove from favourites" : "Add to favourites"}
              style={({ pressed }) => [s.iconBtn, pressed && s.hover]}
            >
              <Ionicons
                name={isFav ? "star" : "star-outline"}
                size={14}
                color={isFav ? COLOR.accent : COLOR.fgMuted}
              />
            </Pressable>
          ) : null}
          <Pressable
            onPress={() => sessionChrome$.searchOpen.set(!searchOpen)}
            accessibilityLabel="Find in thread"
            style={({ pressed }) => [s.iconBtn, pressed && s.hover]}
          >
            <Ionicons name="search" size={14} color={searchOpen ? COLOR.accent : COLOR.fgMuted} />
          </Pressable>
          <Pressable
            onPress={() => sessionChrome$.envOpen.set(true)}
            accessibilityLabel="Thread options"
            style={({ pressed }) => [s.iconBtn, pressed && s.hover]}
          >
            <Ionicons name="ellipsis-horizontal" size={16} color={COLOR.fgMuted} />
          </Pressable>
          {/* The Changes dock is a companion to a transcript — with a page tab
              open there is no diff for it to show, so the control goes with the
              rest of the thread chrome rather than lighting up on nothing. */}
          <Pressable
            onPress={() => nav$.dock.set(!dock)}
            accessibilityLabel={dock ? "Hide changes" : "Show changes"}
            style={({ pressed }) => [s.iconBtn, pressed && s.hover]}
          >
            <Ionicons
              name={dock ? "reader" : "reader-outline"}
              size={15}
              color={dock ? COLOR.accent : COLOR.fgMuted}
            />
          </Pressable>
        </>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  root: {
    height: TITLEBAR_INSET,
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingHorizontal: 6,
  },
  flex1: { flex: 1 },
  hover: { backgroundColor: T.surface },
  iconBtn: {
    height: 24,
    width: 24,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 6,
  },
  tab: {
    maxWidth: 190,
    height: 26,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 7,
    paddingLeft: 9,
    paddingRight: 5,
  },
  tabActive: { backgroundColor: T.surfaceHover },
  tabDotFallback: { height: 6, width: 6, borderRadius: 999, backgroundColor: T.fgFaint },
  tabLabel: { flexShrink: 1, fontSize: 11.5, color: T.fgMuted },
  tabLabelActive: { color: T.fg },
  tabClose: {
    height: 16,
    width: 16,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 4,
  },
});
