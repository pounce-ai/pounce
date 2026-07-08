import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActionSheetIOS, Pressable, Text, View } from "react-native";
import { KeyboardAvoidingView, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { FadeIn } from "react-native-reanimated";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useSelector } from "@legendapp/state/react";
import type { LegendListRef } from "@legendapp/list/react-native";
import type { PermissionMode, TimelineEvent } from "@litter/shared";
import { collapseToolResults, Timeline } from "@/components/Timeline";
import { WorkingIndicator } from "@/components/WorkingIndicator";
import { TimelineSkeleton } from "@/components/Skeleton";
import { Composer, type ComposerHandle, type ComposerSubmit } from "@/components/Composer";
import { MarkerSheet, type Marker } from "@/components/MarkerSheet";
import { shortModel, ThreadUsageSummary } from "@/components/ThreadStatusBar";
import { EnvironmentSheet } from "@/components/EnvironmentSheet";
import { ModelSheet } from "@/components/ModelSheet";
import { useTimeline } from "@/hooks/useTimeline";
import {
  cachedModels,
  capsFor,
  connection$,
  isFavThread,
  defaultMarked,
  isMarked,
  markOpened,
  markers$,
  modelForThread,
  pendingTurns$,
  sessions$,
  setThreadModel,
  toggleFavThread,
  toggleMarker,
} from "@/state/stores";
import { fetchMessages, fetchUsage, interruptTurn, streamLiveMessage, type ThreadUsage } from "@/services/bridge";
import { Ionicons } from "@expo/vector-icons";
import { ActivityDot, ACTIVITY_LABEL, AgentLogo, cn, COLOR } from "@/ui";
import { effectiveCaps, modesFor, REASONING_EFFORTS, type ReasoningEffort } from "@/ui/agent-meta";

/** Order host-fetched history chronologically. Turns share one timestamp, so a
 *  stable sort keeps items within a turn in place while fixing turn order — a
 *  guard against a bridge that returns turns newest-first. Only safe on pure
 *  host-side arrays (uniform host clock), never on the mixed streaming buffer. */
function chrono(events: TimelineEvent[]): TimelineEvent[] {
  return events
    .map((e, i) => [e, i] as const)
    .sort(([a, ai], [b, bi]) => (a.ts ?? "").localeCompare(b.ts ?? "") || ai - bi)
    .map(([e]) => e);
}

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
  const fav = useSelector(() => (session ? isFavThread(session.id) : false));
  const selectedModel = useSelector(() => (session ? modelForThread(session.id) : undefined));
  const [modelSheet, setModelSheet] = useState(false);
  // Permission mode + reasoning effort live on the status bar now (moved out of
  // the composer). Session-view state; undefined mode = the agent's default.
  const [mode, setMode] = useState<PermissionMode | undefined>(undefined);
  const [effort, setEffort] = useState<ReasoningEffort | undefined>(undefined);
  // A freshly-created thread still carries its temporary new_* id here; favouriting
  // it would orphan once live sync swaps in the real id, so gate the star on that.
  const canFavourite = !!session && !session.id.startsWith("new_");

  // Record that the user opened this thread — drives the home "Jump back in" strip.
  useEffect(() => {
    if (session?.id && !session.id.startsWith("new_")) {
      markOpened(session.id, new Date().toISOString());
    }
  }, [session?.id]);

  const demoTl = useTimeline(id!, undefined, !live);
  const [liveEvents, setLiveEvents] = useState<TimelineEvent[]>([]);
  const [loading, setLoading] = useState(false);
  // A live fetch can fail (host asleep, off Wi-Fi, bridge not running). We track
  // it so an unreachable host shows "couldn't load · retry" instead of masking
  // as an empty conversation. Bumping `reload` re-runs the fetch.
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const retry = useCallback(() => setReload((n) => n + 1), []);

  // Token/cost usage for the status bar — best-effort, refreshed on open and
  // after each turn. Skipped for freshly-created (new_*) threads.
  const [usage, setUsage] = useState<ThreadUsage | null>(null);
  const refreshUsage = useCallback(() => {
    if (!live || !session?.id || session.id.startsWith("new_")) return;
    fetchUsage(session.hostId, session.agent, session.id, session.cwd)
      .then(setUsage)
      .catch(() => {});
  }, [live, session?.hostId, session?.agent, session?.id, session?.cwd]);
  useEffect(() => { refreshUsage(); }, [refreshUsage, reload]);

  useEffect(() => {
    if (!live || !session?.id) return;
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    fetchMessages(session.hostId, session.agent, session.id)
      .then((ev) => { if (!cancelled) { setLiveEvents(chrono(ev)); setFailed(false); } })
      .catch(() => { if (!cancelled) setFailed(true); })
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [live, session?.id, session?.agent, session?.hostId, reload]);

  const rawEvents = live ? liveEvents : demoTl.events;
  // Timeline collapses paired tool results into their call's accordion, so
  // marker indices must be computed over the same collapsed array it renders.
  const events = useMemo(() => collapseToolResults(rawEvents), [rawEvents]);

  // --- markers: user messages by default, overrides for adds/removals ---
  const listRef = useRef<LegendListRef>(null);
  const composerRef = useRef<ComposerHandle>(null);
  // Tapping "Run" on a shell code block queues !command into the composer for
  // review. Stable so it doesn't churn Timeline's memoized rows.
  const onRunCommand = useCallback(
    (cmd: string) => composerRef.current?.insert(`!${cmd.trim()}`),
    [],
  );
  const [markerSheet, setMarkerSheet] = useState(false);
  const [envSheet, setEnvSheet] = useState(false);
  // Derived inside useSelector so each message's override node is tracked —
  // selecting the parent object breaks on toggles (same reference, no rerender).
  const markers = useSelector<Marker[]>(() =>
    events.flatMap((e, index) => {
      if (e.type !== "user_message" && e.type !== "assistant_message") return [];
      // Only prose is marker-worthy: a plain message, or a command with an
      // accompanying message. A bare slash command (/exit, /clear) has no text,
      // so it's never auto-marked.
      if (!(markers$[id!][e.id].get() ?? defaultMarked(e, session?.agent))) return [];
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
      const marked = isMarked(id!, ev, session.agent);
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: [marked ? "Remove marker" : "Add marker", "Cancel"],
          cancelButtonIndex: 1,
        },
        (i) => {
          if (i === 0) toggleMarker(id!, ev, session.agent);
        },
      );
    },
    [id],
  );

  // One message → one streamed turn. Errors propagate so the Composer can
  // restore the user's draft (or the queue drain can surface the failure).
  const runTurn = useCallback(async (s: ComposerSubmit) => {
    if (!session) return;
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
        (ev) =>
          setLiveEvents((e) => {
            // The daemon echoes the user turn as it streams; drop our optimistic
            // placeholder then so the message isn't shown twice.
            const base =
              ev.type === "user_message" && !ev.id.startsWith("opt:")
                ? e.filter((x) => !x.id.startsWith("opt:"))
                : e;
            return mergeById(base, [ev]);
          }),
        {
          images: s.images,
          permissionMode: modesFor(session.agent).length > 1
            ? (mode ?? modesFor(session.agent)[0]?.value)
            : undefined,
          reasoningEffort: effectiveCaps(session.agent, capsFor(session.agent)).thinking ? effort : undefined,
          model: modelForThread(session.id),
        },
      );
      if (threadId) setLiveEvents(chrono(await fetchMessages(session.hostId, session.agent, threadId)));
      refreshUsage();
      // A freshly-created task carries a temporary `new_*` id the daemon doesn't
      // know. Once the first turn returns the real thread id, re-key the local
      // session onto it and swap the route — otherwise the session stays orphaned
      // ("Queued" forever, empty on reopen) while sync surfaces the real thread as
      // a separate entry.
      if (threadId && threadId !== session.id && session.id.startsWith("new_")) {
        const data = sessions$[session.id].get();
        if (data) {
          sessions$[threadId].set({ ...data, id: threadId, activity: "idle" });
          sessions$[session.id].delete();
          router.replace(`/session/${threadId}`);
        }
      }
    } else {
      const { getRuntime } = await import("@/services/runtime");
      const rt = await getRuntime();
      await rt.sendMessage({
        conversation: { id: session.id, agent: session.agent, threadId: session.id } as never,
        project: { path: session.cwd ?? "" } as never,
        text: s.text,
      });
    }
  }, [session, live, refreshUsage, mode, effort, router]);

  // Follow-ups typed while a turn runs are queued and drained in order — the
  // Claude Code / Codex model. inFlightRef gates re-entrancy synchronously so a
  // fast second submit can't start a parallel turn before `sending` updates.
  const inFlightRef = useRef(false);
  const queueRef = useRef<ComposerSubmit[]>([]);
  const [queued, setQueued] = useState<ComposerSubmit[]>([]);

  const onSubmit = useCallback(async (s: ComposerSubmit) => {
    if (inFlightRef.current) {
      queueRef.current = [...queueRef.current, s];
      setQueued(queueRef.current);
      return;
    }
    inFlightRef.current = true;
    setSending(true);
    try {
      await runTurn(s);
      // Drain queued follow-ups, unless a stop cleared the flag mid-way.
      while (inFlightRef.current && queueRef.current.length) {
        const [next, ...rest] = queueRef.current;
        queueRef.current = rest;
        setQueued(rest);
        await runTurn(next);
      }
    } finally {
      inFlightRef.current = false;
      setSending(false);
    }
  }, [runTurn]);

  const cancelQueued = useCallback((i: number) => {
    queueRef.current = queueRef.current.filter((_, n) => n !== i);
    setQueued(queueRef.current);
  }, []);

  const stop = useCallback(async () => {
    if (!session) return;
    // Cancel pending follow-ups and halt the drain loop, then interrupt the turn.
    queueRef.current = [];
    setQueued([]);
    inFlightRef.current = false;
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
  // Phase label for the working indicator: "Responding…" once assistant text is
  // streaming, otherwise "Thinking…".
  const tail = rawEvents[rawEvents.length - 1];
  const workLabel =
    tail?.type === "assistant_message" && tail.streaming ? "Responding…" : "Thinking…";

  // Permission-mode + reasoning-effort controls (shown on the status bar).
  const modes = modesFor(session.agent);
  const showMode = modes.length > 1;
  const showEffort = caps.thinking;
  const activeMode = mode ?? modes[0]?.value;
  const modeLabel = activeMode === "default" ? "Mode" : modes.find((m) => m.value === activeMode)?.label ?? "Mode";
  const effortLabel = REASONING_EFFORTS.find((e) => e.value === effort)?.label ?? "Effort";
  const pickSheet = (title: string, labels: string[], onPick: (i: number) => void) =>
    ActionSheetIOS.showActionSheetWithOptions(
      { title, options: [...labels, "Cancel"], cancelButtonIndex: labels.length },
      (i) => { if (i >= 0 && i < labels.length) onPick(i); },
    );
  const openMode = () => pickSheet("Mode", modes.map((m) => `${m.label} · ${m.hint}`), (i) => setMode(modes[i].value));
  const openEffort = () => pickSheet("Reasoning effort", REASONING_EFFORTS.map((e) => e.label), (i) => setEffort(REASONING_EFFORTS[i].value));

  // Combined model·effort pill label for the composer, e.g. "opus 4.7 · High".
  const activeModel = selectedModel ?? usage?.model ?? null;
  const modelName = activeModel ? shortModel(activeModel) : "Model";
  const modelPillLabel =
    showEffort && effort && effort !== "off" ? `${modelName} · ${effortLabel}` : modelName;

  // Session actions now live in the Environment sheet — the "…" button opens it.

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
          <AgentLogo agent={session.agent} size={18} />
          <View className="flex-1">
            <Text numberOfLines={1} className="text-[15px] font-semibold text-fg">{session.title}</Text>
            <View className="mt-0.5 flex-row items-center gap-2">
              <ActivityDot status={session.activity} size={7} />
              <Text className="text-[12px] text-fg-muted">{ACTIVITY_LABEL[session.activity]}</Text>
              {session.branch ? <Text numberOfLines={1} className="shrink font-mono text-[11px] text-fg-faint">⎇ {session.branch}</Text> : null}
              <ThreadUsageSummary usage={usage} />
            </View>
          </View>
          {markers.length ? (
            <Pressable
              onPress={() => setMarkerSheet(true)}
              hitSlop={4}
              className="active:opacity-70 h-7 flex-row items-center gap-1 rounded-full bg-surface-alt px-2"
            >
              <Ionicons name="bookmark" size={12} color={COLOR.accent} />
              <Text className="text-[12px] font-semibold text-fg-muted">{markers.length}</Text>
            </Pressable>
          ) : null}
          {canFavourite ? (
            <Pressable
              onPress={() => toggleFavThread(session.id)}
              className="active:opacity-60 h-9 w-9 items-center justify-center"
            >
              <Ionicons
                name={fav ? "star" : "star-outline"}
                size={19}
                color={fav ? COLOR.accent : COLOR.fgMuted}
              />
            </Pressable>
          ) : null}
          <Pressable
            onPress={() => setEnvSheet(true)}
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
          // Fade the history in so it doesn't snap in after the skeleton.
          <Animated.View className="flex-1" entering={FadeIn.duration(260)}>
            <Timeline
              events={rawEvents}
              agent={session.agent}
              sessionId={id!}
              listRef={listRef}
              onLongPressEvent={onLongPressEvent}
              onRunCommand={canSteer ? onRunCommand : undefined}
              footer={running ? <WorkingIndicator agent={session.agent} label={workLabel} /> : undefined}
            />
          </Animated.View>
        )}
      </View>

      <MarkerSheet
        visible={markerSheet}
        markers={markers}
        agent={session.agent}
        onJump={jumpTo}
        onClose={() => setMarkerSheet(false)}
      />

      <EnvironmentSheet
        visible={envSheet}
        session={session}
        running={running}
        onClose={() => setEnvSheet(false)}
        onStop={() => void stop()}
        onViewChanges={() => router.push(`/changes?id=${session.id}`)}
        onTerminal={() => router.push(`/terminal?id=${session.id}`)}
      />

      <ModelSheet
        visible={modelSheet}
        hostId={session.hostId}
        agent={session.agent}
        current={selectedModel ?? usage?.model ?? null}
        pinned={[selectedModel, usage?.model, ...(usage?.models ?? [])].filter(
          (m): m is string => !!m && m !== "<synthetic>",
        )}
        onSelect={(modelId) => {
          setThreadModel(session.id, modelId);
          setModelSheet(false);
          // Immediate, informative confirmation — switching invalidates the
          // per-model prompt cache, so the next turn re-sends the full
          // conversation to the new model. Any daemon warning (deprecation,
          // reroute) still arrives inline when that turn runs.
          const name = cachedModels(session.hostId, session.agent)?.find((m) => m.id === modelId)?.name ?? modelId;
          setLiveEvents((e) =>
            mergeById(e, [{
              id: `switch:${Date.now()}`,
              conversationId: session.id,
              seq: Number.MAX_SAFE_INTEGER,
              ts: new Date().toISOString(),
              type: "system_event",
              level: "info",
              message: `Switched to ${name}. Your next message re-sends the full conversation as context to it (fresh cache).`,
            }]),
          );
        }}
        effort={canSteer && showEffort ? { label: effortLabel, onPress: openEffort } : null}
        onClose={() => setModelSheet(false)}
      />

      {/* Composer (model·effort, mode, mic and send now live inside its card) */}
      <View style={{ paddingBottom: insets.bottom + 8 }} className="bg-bg-elevated px-3 pt-2">
        {!canSteer ? (
          <Text className="px-1 pb-2 text-[12px] text-fg-faint">
            Archived session — worktree was removed. Read-only.
          </Text>
        ) : null}
        {queued.length > 0 ? (
          <View className="mb-2 gap-1.5">
            {queued.map((q, i) => (
              <View
                key={i}
                className="flex-row items-center gap-2 rounded-xl border border-border bg-surface-alt px-3 py-2"
              >
                <Ionicons name="time-outline" size={13} color={COLOR.fgFaint} />
                <Text numberOfLines={1} className="flex-1 text-[12px] text-fg-muted">
                  {q.text || (q.images.length ? "🖼️ Image" : "")}
                </Text>
                <Pressable onPress={() => cancelQueued(i)} hitSlop={8}>
                  <Ionicons name="close" size={14} color={COLOR.fgMuted} />
                </Pressable>
              </View>
            ))}
            <Text className="px-1 text-[11px] text-fg-faint">Queued — sends after the current reply</Text>
          </View>
        ) : null}
        <Composer
          ref={composerRef}
          agent={session.agent}
          caps={caps}
          disabled={!canSteer}
          sending={sending}
          running={running}
          hostId={session.hostId}
          cwd={session.cwd}
          onSubmit={onSubmit}
          onStop={stop}
          model={live && !!session.cwd ? { label: modelPillLabel, onPress: () => setModelSheet(true) } : null}
          mode={canSteer && showMode ? { label: modeLabel, active: activeMode !== "default", onPress: openMode } : null}
        />
      </View>
    </KeyboardAvoidingView>
  );
}
