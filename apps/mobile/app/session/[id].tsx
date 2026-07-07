import { useCallback, useEffect, useRef, useState } from "react";
import { ActionSheetIOS, Pressable, Text, View } from "react-native";
import { KeyboardAvoidingView, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useSelector } from "@legendapp/state/react";
import type { LegendListRef } from "@legendapp/list/react-native";
import type { TimelineEvent } from "@litter/shared";
import { isEmptyUserMessage, parseUserMessage } from "@litter/transcript";
import { Timeline } from "@/components/Timeline";
import { TimelineSkeleton } from "@/components/Skeleton";
import { Composer, type ComposerSubmit } from "@/components/Composer";
import { MarkerRail, type Marker } from "@/components/MarkerRail";
import { MarkerSheet } from "@/components/MarkerSheet";
import { useTimeline } from "@/hooks/useTimeline";
import {
  capsFor,
  connection$,
  isMarked,
  markers$,
  pendingTurns$,
  sessions$,
  toggleMarker,
} from "@/state/stores";
import { fetchMessages, interruptTurn, streamLiveMessage } from "@/services/bridge";
import { Ionicons } from "@expo/vector-icons";
import { ActivityDot, ACTIVITY_LABEL, AgentLogo, cn, COLOR } from "@/ui";
import { effectiveCaps } from "@/ui/agent-meta";

function mergeById(cur: TimelineEvent[], inc: TimelineEvent[]): TimelineEvent[] {
  const out = cur.slice();
  const idx = new Map(out.map((e, i) => [e.id, i] as const));
  for (const ev of inc) {
    const i = idx.get(ev.id);
    if (i != null) out[i] = ev;
    else { idx.set(ev.id, out.length); out.push(ev); }
  }
  return out;
}

export default function SessionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);

  const session = useSelector(() => sessions$[id!].get());
  // "live" = a real bridge is in use (not demo). Gating history on the transient
  // connection *status* meant a flaky/settling reconnect left threads blank even
  // though the host was reachable; fetchMessages already degrades gracefully.
  const live = useSelector(() => !connection$.demo.get());
  const reportedCaps = useSelector(() => (session ? capsFor(session.agent) : null));

  const demoTl = useTimeline(id!, undefined, !live);
  const [liveEvents, setLiveEvents] = useState<TimelineEvent[]>([]);
  const [loading, setLoading] = useState(false);
  // A live fetch can fail (host asleep, off Wi-Fi, bridge not running). We track
  // it so an unreachable host shows "couldn't load · retry" instead of masking
  // as an empty conversation. Bumping `reload` re-runs the fetch.
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const retry = useCallback(() => setReload((n) => n + 1), []);

  useEffect(() => {
    if (!live || !session?.id) return;
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    fetchMessages(session.hostId, session.agent, session.id)
      .then((ev) => { if (!cancelled) { setLiveEvents(ev); setFailed(false); } })
      .catch(() => { if (!cancelled) setFailed(true); })
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [live, session?.id, session?.agent, session?.hostId, reload]);

  const events = live ? liveEvents : demoTl.events;

  // --- markers: user messages by default, overrides for adds/removals ---
  const listRef = useRef<LegendListRef>(null);
  const [markerSheet, setMarkerSheet] = useState(false);
  // Derived inside useSelector so each message's override node is tracked —
  // selecting the parent object breaks on toggles (same reference, no rerender).
  const markers = useSelector<Marker[]>(() =>
    events.flatMap((e, index) => {
      if (e.type !== "user_message" && e.type !== "assistant_message") return [];
      // Empty envelopes render nothing (UserRow returns null) — never dot them.
      const def =
        e.type === "user_message" &&
        !isEmptyUserMessage(parseUserMessage(e.text, session?.agent));
      if (!(markers$[id!][e.id].get() ?? def)) return [];
      return [{ id: e.id, index, type: e.type, text: e.text, ts: e.ts }];
    }),
  );

  const jumpTo = useCallback((index: number) => {
    listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.1 });
  }, []);

  const onLongPressEvent = useCallback(
    (ev: TimelineEvent) => {
      // Optimistic ids are replaced on refetch — a toggle here would orphan.
      if (ev.id.startsWith("opt:")) return;
      const marked = isMarked(id!, ev);
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: [marked ? "Remove marker" : "Add marker", "Cancel"],
          cancelButtonIndex: 1,
        },
        (i) => {
          if (i === 0) toggleMarker(id!, ev);
        },
      );
    },
    [id],
  );

  // Errors propagate so the Composer can restore the user's draft.
  const onSubmit = useCallback(async (s: ComposerSubmit) => {
    if (!session) return;
    setSending(true);
    try {
      if (live) {
        const optimistic: TimelineEvent = {
          id: `opt:${Date.now()}`,
          conversationId: session.id,
          seq: Number.MAX_SAFE_INTEGER,
          ts: new Date().toISOString(),
          type: "user_message",
          text: s.text || (s.images.length ? "🖼️ Image" : ""),
        };
        setLiveEvents((e) => mergeById(e, [optimistic]));
        const { threadId } = await streamLiveMessage(
          session.hostId,
          session.agent,
          session.id,
          session.cwd,
          s.text,
          (ev) => setLiveEvents((e) => mergeById(e, [ev])),
          { images: s.images, permissionMode: s.permissionMode, reasoningEffort: s.reasoningEffort },
        );
        if (threadId) setLiveEvents(await fetchMessages(session.hostId, session.agent, threadId));
      } else {
        const { getRuntime } = await import("@/services/runtime");
        const rt = await getRuntime();
        await rt.sendMessage({
          conversation: { id: session.id, agent: session.agent, threadId: session.id } as never,
          project: { path: session.cwd ?? "" } as never,
          text: s.text,
        });
      }
    } finally {
      setSending(false);
    }
  }, [session, live]);

  const stop = useCallback(async () => {
    if (!session) return;
    setStopping(true);
    try {
      await interruptTurn(session.hostId, session.agent, session.id);
    } finally {
      setStopping(false);
    }
  }, [session]);

  // Fire the first turn handed off from the New-task composer (once).
  const firedPending = useRef(false);
  useEffect(() => {
    if (firedPending.current || !session) return;
    const pending = pendingTurns$[id!].get();
    if (!pending) return;
    firedPending.current = true;
    pendingTurns$[id!].delete();
    void Promise.resolve(onSubmit(pending)).catch(() => {});
  }, [session, id, onSubmit]);

  if (!session) {
    return (
      <View className="flex-1 items-center justify-center bg-bg">
        <Text className="text-fg-muted">Session not found.</Text>
      </View>
    );
  }

  const canSteer = session.isLive;
  const caps = effectiveCaps(session.agent, reportedCaps);
  const running = sending || session.activity === "running" || session.activity === "streaming";

  // All session actions in one thumb-zone sheet (slides up from the bottom).
  const openActions = () => {
    const acts: { label: string; run: () => void }[] = [];
    if (running) acts.push({ label: "Stop agent", run: () => void stop() });
    if (markers.length) acts.push({ label: "Markers", run: () => setMarkerSheet(true) });
    if (session.cwd) {
      acts.push({ label: "View changes", run: () => router.push(`/changes?id=${session.id}`) });
      acts.push({ label: "Open terminal", run: () => router.push(`/terminal?id=${session.id}`) });
    }
    if (!acts.length) return;
    const labels = acts.map((a) => a.label);
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: session.title,
        options: [...labels, "Cancel"],
        cancelButtonIndex: labels.length,
        destructiveButtonIndex: running ? 0 : undefined,
      },
      (i) => { if (i >= 0 && i < acts.length) acts[i].run(); },
    );
  };

  return (
    <KeyboardAvoidingView
      className="flex-1 bg-bg"
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={0}
    >
      <Stack.Screen options={{ headerShown: false }} />
      {/* Header */}
      <View style={{ paddingTop: insets.top }} className="border-b border-border bg-bg-elevated">
        <View className="flex-row items-center gap-2 px-3 pb-2.5 pt-1">
          <Pressable onPress={() => router.back()} className="active:opacity-60 h-9 w-9 items-center justify-center">
            <Text className="text-[22px] text-fg">‹</Text>
          </Pressable>
          <View className="flex-1">
            <Text numberOfLines={1} className="text-[15px] font-semibold text-fg">{session.title}</Text>
            <View className="mt-0.5 flex-row items-center gap-2">
              <ActivityDot status={session.activity} size={7} />
              <Text className="text-[12px] text-fg-muted">{ACTIVITY_LABEL[session.activity]}</Text>
              {session.branch ? <Text numberOfLines={1} className="font-mono text-[11px] text-fg-faint">⎇ {session.branch}</Text> : null}
            </View>
          </View>
          <AgentLogo agent={session.agent} size={16} />
          <Pressable
            onPress={openActions}
            className="active:opacity-60 h-9 w-9 items-center justify-center"
          >
            <Ionicons
              name="ellipsis-horizontal"
              size={20}
              color={running ? COLOR.danger : COLOR.fgMuted}
            />
          </Pressable>
        </View>
      </View>

      <View className="flex-1">
        {loading && events.length === 0 ? (
          <TimelineSkeleton />
        ) : live && failed && events.length === 0 ? (
          <View className="flex-1 items-center justify-center px-8">
            <Ionicons name="cloud-offline-outline" size={34} color={COLOR.fgFaint} />
            <Text className="mt-3 text-center text-[15px] font-semibold text-fg">Couldn't load this conversation</Text>
            <Text className="mt-1 text-center text-[13px] text-fg-muted">
              Make sure {session.host || "your computer"} is awake and the Pounce Bridge is running on the same Wi‑Fi.
            </Text>
            <Pressable onPress={retry} className="active:opacity-80 mt-5 rounded-full bg-accent px-5 py-2.5">
              <Text className="text-[14px] font-semibold text-white">Retry</Text>
            </Pressable>
          </View>
        ) : events.length === 0 ? (
          <View className="flex-1 items-center justify-center px-8">
            <Text className="text-[34px]">💬</Text>
            <Text className="mt-3 text-center text-[15px] font-semibold text-fg">No messages yet</Text>
            <Text className="mt-1 text-center text-[13px] text-fg-muted">Send a message below to get this thread going.</Text>
          </View>
        ) : (
          <Timeline
            events={events}
            agent={session.agent}
            sessionId={id!}
            listRef={listRef}
            onLongPressEvent={onLongPressEvent}
          />
        )}
        <MarkerRail
          markers={markers}
          total={events.length}
          onJump={jumpTo}
          onOpenList={() => setMarkerSheet(true)}
        />
      </View>

      <MarkerSheet
        visible={markerSheet}
        markers={markers}
        agent={session.agent}
        onJump={jumpTo}
        onClose={() => setMarkerSheet(false)}
      />

      {/* Composer */}
      <View style={{ paddingBottom: insets.bottom + 8 }} className="border-t border-border bg-bg-elevated px-3 pt-2">
        {!canSteer ? (
          <Text className="px-1 pb-2 text-[12px] text-fg-faint">
            Archived session — worktree was removed. Read-only.
          </Text>
        ) : null}
        <Composer
          agent={session.agent}
          caps={caps}
          disabled={!canSteer}
          sending={sending}
          hostId={session.hostId}
          cwd={session.cwd}
          onSubmit={onSubmit}
        />
      </View>
    </KeyboardAvoidingView>
  );
}
