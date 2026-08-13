import { useCallback, useEffect, useMemo, useRef, useState } from "react";
// eslint-disable-next-line @react-native/no-deprecated-api -- core Clipboard is
// the only clipboard already inside shipped binaries (OTA-safe).
import { ActivityIndicator, Clipboard, Pressable, Text, TextInput, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Platform } from "react-native";
import Animated, { FadeIn, FadeOut, ZoomIn, ZoomOut } from "../components/animation";
import {
  ChatKeyboardSticky,
  COMPOSER_OVERLAYS_LIST,
  useChatKeyboard,
} from "../components/ChatList";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useSelector } from "@legendapp/state/react";
import { useQuery } from "@tanstack/react-query";
import type { LegendListRef } from "@legendapp/list/react-native";
import { adoptedMode } from "../state/permissionModes";
import type { PermissionMode, TimelineEvent } from "@pounce/shared";
import { collapseToolResults, Timeline } from "../components/Timeline";
import { deriveTaskTimeline } from "../components/taskEvents";
import { TaskProgressBar } from "../components/TaskProgress";
import { ShimmerLabel } from "../components/ShimmerLabel";
import { ComposerScrim, SCRIM_HEIGHT } from "../components/ComposerScrim";
import { useSessionChrome, usePublishTasks, usePublishUsage } from "../state/sessionChrome";
import { Composer, type ComposerHandle, type ComposerSubmit } from "../components/Composer";
import { DropZone, type DroppedFile } from "../components/DropZone";
import { MarkerSheet, type Marker } from "../components/MarkerSheet";
import { TurnRail } from "../components/TurnRail";

/**
 * The per-turn rail beside the transcript — parked, not deleted.
 *
 * The idea holds (it's the marker set drawn as a rail instead of hidden behind
 * a button) but this drawing of it didn't earn its place, so it's off until it
 * does. Everything it needs is still wired: the markers already exist, Timeline
 * still offers `onVisibleIndex`, and the transcript already sits in a row that
 * has room for it. Flipping this back to `true` is the whole revisit.
 */
const TURN_RAIL = false;
import { shortModel, ThreadUsageSummary } from "../components/ThreadStatusBar";
import { EnvironmentSheet } from "../components/EnvironmentSheet";
import { ModelSheet } from "../components/ModelSheet";
import { useTimeline } from "../hooks/useTimeline";
import {
  addSources,
  cachedModels,
  capsFor,
  clearPendingPrompt,
  connection$,
  defaultMarked,
  isMarked,
  isThreadInteractive,
  markOpened,
  mergeRemoteMarkers,
  modelForThread,
  pendingPrompts$,
  pendingTurns$,
  rekeyThread,
  rekeyedThreadIds$,
  removeSource,
  saveThreadMessages,
  setPendingPrompt,
  setThreadModel,
  sources$,
  toggleFavThread,
  toggleMarker,
  type ThreadSource,
} from "../state/stores";
import {
  useAgentCaps,
  useFavThreadSet,
  useMessages,
  useThread,
  useThreadMarkers,
  useThreadModel,
} from "../state/db/hooks";
import {
  diffTotals,
  fetchGitChanges,
  fetchMessages,
  fetchThreadMarkers,
  fetchUsage,
  interruptTurn,
  runExec,
  pushMarker,
  respondPermission,
  respondPrompt,
  searchMessages,
  sendSessionInput,
  startInteractive,
  streamLiveMessage,
  type MessageSearchHit,
  type ThreadUsage,
} from "../services/bridge";
import { PounceIcon } from "../ui/native/Icon";
import { BranchChip, COLOR, INPUT_TWEAKS, IS_DESKTOP, pickSheet } from "../ui";
import { effectiveCaps, modesFor, REASONING_EFFORTS, type ReasoningEffort } from "../ui/agent-meta";

/** Desktop renders this screen in a wide pane: pickers use Alert instead of
 *  ActionSheetIOS (which doesn't exist there) and the transcript is capped at
 *  a readable column width. */
const DESKTOP = Platform.OS === "macos" || Platform.OS === "windows";

/** One size for every control in the thread header — back, agent mark, search
 *  and more. They had drifted to 22/18/18/20, which reads as a wobble along a
 *  row the eye scans horizontally. */
const HEADER_ICON = 20;

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

/** Image files dropped on the composer attach as previews, not @mentions. */
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|heic|heif|tiff?)$/i;

/** MIME type from an image filename — for drops where the OS gave none. */
function mimeForImage(name: string): string {
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    heic: "image/heic",
    heif: "image/heif",
    tif: "image/tiff",
    tiff: "image/tiff",
  };
  return map[ext] ?? "image/png";
}

/** True when `b` is the transcript re-parse of streamed event `a`. The daemon
 *  mints fresh event ids when it re-reads the transcript after a turn, so id
 *  equality alone can't collapse a finished turn's streamed copy against the
 *  fetched one — without this, the whole reply renders twice at completion. */
function isEquivalentEvent(a: TimelineEvent, b: TimelineEvent): boolean {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case "user_message":
    case "assistant_message":
    case "thinking_finished":
      return a.text === (b as typeof a).text;
    case "tool_call":
      return a.call.id === (b as typeof a).call.id;
    case "tool_result":
      return a.result.toolCallId === (b as typeof a).result.toolCallId;
    default:
      return false;
  }
}

function mergeById(cur: TimelineEvent[], inc: TimelineEvent[]): TimelineEvent[] {
  const out = cur.slice();
  const idx = new Map(out.map((e, i) => [e.id, i] as const));
  for (const ev of inc) {
    const i = idx.get(ev.id);
    if (i != null) out[i] = ev;
    else {
      idx.set(ev.id, out.length);
      out.push(ev);
    }
  }
  return out;
}

/** Fold a fetched transcript into the rendered list without disturbing rows
 *  already on screen. A fetched event matching a rendered one only by content
 *  (re-parses mint fresh ids) is dropped in favor of the RENDERED event — its
 *  row keeps its key, so the just-streamed reply never remounts/re-measures at
 *  the exact moment the anchor spacer collapses. (Swapping to the fetched copy
 *  reset the row to its estimated size and scroll-to-end then landed at the
 *  START of the message.) Rendered extras the transcript hasn't flushed yet are
 *  kept — the render list only ever accretes. */
function reconcileFetched(cur: TimelineEvent[], fetched: TimelineEvent[]): TimelineEvent[] {
  if (!cur.length) return fetched;
  const used = new Set<string>();
  const next = fetched.map((f) => {
    const match = cur.find((e) => !used.has(e.id) && (e.id === f.id || isEquivalentEvent(e, f)));
    if (!match) return f;
    used.add(match.id);
    // Adopt the fetched (canonical) payload — it carries the settled flags,
    // e.g. assistant_message.streaming=false, which flips the row off the
    // streaming renderer — but under the RENDERED id, so the row's key and
    // measurement survive.
    return match.id === f.id ? f : { ...f, id: match.id };
  });
  const extras = cur.filter(
    (e) => !used.has(e.id) && !e.id.startsWith("opt:") && !next.some((f) => f.id === e.id),
  );
  return extras.length ? mergeById(next, extras) : next;
}

export default function SessionScreen() {
  // `at` (optional, ISO timestamp) deep-links to a specific message — search
  // hits pass the matched event's time so we can land on it, not just the
  // thread — and `q` is the matched term, echoed as a yellow row highlight.
  const { id: routeId, at, q } = useLocalSearchParams<{ id: string; at?: string; q?: string }>();
  // A new_* thread's first turn re-keys it onto the daemon's real id; follow
  // that alias here, in place — replacing the route would remount the screen
  // and visibly blank the timeline right as the reply finishes.
  const rekeyedId = useSelector(() => rekeyedThreadIds$[routeId!].get());
  const id = rekeyedId ?? routeId;
  const router = useRouter();
  const { theme } = useUnistyles();
  const [sending, setSending] = useState(false);

  const session = useThread(id);
  // "live" = a real bridge is in use (not demo). Gating history on the transient
  // connection *status* meant a flaky/settling reconnect left threads blank even
  // though the host was reachable; fetchMessages already degrades gracefully.
  const live = useSelector(() => !connection$.demo.get());
  const reportedCaps = useAgentCaps(session?.agent);
  const favSet = useFavThreadSet();
  const fav = session ? favSet.has(session.id) : false;
  const selectedModel = useThreadModel(session?.id);
  const [modelSheet, setModelSheet] = useState(false);
  // Permission mode + reasoning effort live on the status bar now (moved out of
  // the composer). Session-view state; undefined mode = the agent's default.
  const [mode, setMode] = useState<PermissionMode | undefined>(undefined);
  const [effort, setEffort] = useState<ReasoningEffort | undefined>(undefined);
  // Reflect the thread's actual permission mode (a terminal session may run in
  // acceptEdits/plan/…) so the picker isn't stuck on default — but only ever
  // DOWNWARD. Taking over a thread that was running in acceptEdits used to move
  // the picker, and the user with it, into approving file writes without asking.
  // See adoptedMode: a stricter mode is adopted, a looser one is left to pick.
  useEffect(() => {
    setMode((shown) => adoptedMode(shown, session?.permissionMode));
  }, [session?.permissionMode]);
  // A freshly-created thread still carries its temporary new_* id here; favouriting
  // it would orphan once live sync swaps in the real id, so gate the star on that.
  const canFavourite = !!session && !session.id.startsWith("new_");

  // Record that the user opened this thread — kept as visit history (the Live
  // strip now orders by agent activity, not visits).
  useEffect(() => {
    if (session?.id && !session.id.startsWith("new_")) {
      markOpened(session.id, new Date().toISOString());
    }
  }, [session?.id]);

  const demoTl = useTimeline(id!, undefined, !live);
  const [liveEvents, setLiveEvents] = useState<TimelineEvent[]>([]);
  // Whether the timeline is pinned to the newest message — drives the floating
  // "jump to latest" pill that shows when the user has scrolled up.
  const [atBottom, setAtBottom] = useState(true);
  // False until the transcript list reports its initial render is done. Drives
  // the covering loading label — see the overlay in the Timeline branch.
  const [listReady, setListReady] = useState(false);
  /**
   * Whether the floating "Latest" affordance is welcome right now.
   *
   * Being away from the bottom is not, by itself, a reason to offer a way back:
   * scrolling UP is the user deliberately going to read history, and a pill
   * appearing over the text they just went to find is an interruption. So it
   * stays hidden while they head backwards, and returns when they either turn
   * around (scrolling down = heading for the newest message) or when something
   * NEW arrives while they are away — which is the one case worth surfacing
   * unprompted, since the agent is live and they would otherwise miss it.
   */
  const [scrollDir, setScrollDir] = useState<"up" | "down" | null>(null);
  const [newWhileAway, setNewWhileAway] = useState(false);
  const countWhenLeftRef = useRef(0);
  // Opening a different thread is a clean slate for all of the above.
  //
  // Keyed on routeId, NOT id. `id` also flips when a new_* thread re-keys onto
  // the daemon's real id mid-turn — and that deliberately does not remount the
  // screen (see the alias above), so the list underneath keeps its mount. Since
  // `onLoad` is a once-per-mount signal, resetting listReady on a re-key armed a
  // covering overlay that nothing could ever clear: the first task a new user
  // ran finished behind a permanent "Loading conversation…", while opening the
  // same thread again in a fresh tab rendered it fine.
  useEffect(() => {
    setListReady(false);
    setScrollDir(null);
    setNewWhileAway(false);
  }, [routeId]);
  // ChatGPT-style send anchor: the id of the just-sent (optimistic) user
  // message. While set, Timeline scrolls it to the TOP of the viewport, shows
  // a footer spacer for the reply to stream into, and suspends pin-to-tail.
  // Set on submit; cleared when the turn completes (running → false) or when
  // the user taps the Latest pill. null = today's pinned-to-tail behaviour.
  const [anchorId, setAnchorId] = useState<string | null>(null);

  // Thread history via react-query. `recent` (last 4 turns) paints instantly;
  // `full` is gated on `recent` settling, then backfills the whole history. This
  // is the two-query recent-first pattern — react-query dedupes, cancels stale
  // fetches on navigation, caches per thread, and orders the two, so there's no
  // manual race. Each stage REPLACES (event ids are seq-based, so merging would
  // duplicate); an in-flight live turn re-appends its streamed events after.
  // `new_*` threads don't exist on the host yet — fetching their transcript
  // resolves EMPTY, and the history-seed effect would replace liveEvents with
  // that emptiness, erasing the optimistic first message mid-send.
  const canFetch = live && !!session?.id && !session.id.startsWith("new_");
  const host = session?.hostId;
  const agent = session?.agent;
  const tid = session?.id;
  // A turn running in ANOTHER window (a terminal / FleetView Claude Code
  // session) only reaches us via transcript re-reads, so its tool calls and
  // messages appear a whole sync cycle late (the "why is Pounce blank mid-turn"
  // gap). While such a thread is active — but NOT while we're the one streaming,
  // which would clobber live events — poll the recent turns fast so mirrored
  // activity shows near-real-time like the terminal does.
  // awaiting_input polls fast too: a thread blocked on an interactive prompt
  // looks idle in its transcript, and without the fast poll the synthesized
  // prompt_request (and its clearing, once answered anywhere) lags a full sync.
  const mirroredRunning =
    (session?.activity === "running" ||
      session?.activity === "streaming" ||
      session?.activity === "awaiting_input") &&
    !sending;
  const recentQ = useQuery({
    queryKey: ["messages", host, agent, tid, "recent"],
    queryFn: () => fetchMessages(host!, agent!, tid!, { limit: 4 }),
    enabled: canFetch,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    refetchInterval: mirroredRunning ? 2500 : false,
  });
  const fullQ = useQuery({
    queryKey: ["messages", host, agent, tid, "full"],
    queryFn: () => fetchMessages(host!, agent!, tid!),
    enabled: canFetch && recentQ.isFetched,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  // Token/cost usage for the status bar — best-effort, refreshed on open and
  // after each turn. Skipped for freshly-created (new_*) threads.
  const [usage, setUsage] = useState<ThreadUsage | null>(null);
  // Desktop's status bar renders this instead of a header summary; no-op on mobile.
  usePublishUsage(usage);
  const refreshUsage = useCallback(() => {
    if (!live || !session?.id || session.id.startsWith("new_")) return;
    fetchUsage(session.hostId, session.agent, session.id, session.cwd)
      .then(setUsage)
      .catch(() => {});
  }, [live, session?.hostId, session?.agent, session?.id, session?.cwd]);
  useEffect(() => {
    refreshUsage();
  }, [refreshUsage]);

  // Pull markers made on another device once per thread open. Additive: a
  // local override always wins, so a partial read can't undo one (and a failed
  // read resolves to [] rather than an empty authoritative set).
  useEffect(() => {
    if (!host || !id || id.startsWith("new_")) return;
    let cancelled = false;
    fetchThreadMarkers(host, id)
      .then((remote) => {
        if (!cancelled && remote.length) mergeRemoteMarkers(id, remote);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [host, id]);

  const retry = useCallback(() => {
    void recentQ.refetch();
    void fullQ.refetch();
    refreshUsage();
  }, [recentQ, fullQ, refreshUsage]);

  // Persisted chat history from the DB — renders instantly (and offline) before
  // the bridge answers.
  const persisted = useMessages(tid);
  useEffect(() => {
    // Seed from persisted history once, only while nothing is shown yet — never
    // clobber an in-flight turn or freshly-fetched data.
    if (liveEvents.length === 0 && persisted.length) setLiveEvents(chrono(persisted));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persisted]);

  // Seed the render list from the best available history (full ▸ recent), and
  // persist it so the thread opens instantly next time. Union, not replace:
  // when the rekey alias flips tid (new_* → real) the screen stays mounted, so
  // a fetch racing the transcript flush must not erase streamed events the
  // render list already holds — the render list only ever accretes.
  useEffect(() => {
    const ev = fullQ.data ?? recentQ.data;
    if (ev) {
      setLiveEvents((cur) => reconcileFetched(cur, chrono(ev)));
      if (tid) saveThreadMessages(tid, ev);
    }
  }, [recentQ.data, fullQ.data, tid]);

  // Track the interactive prompt this thread is blocked on. The bridge appends
  // a synthesized prompt_request as the LAST event while (and only while) a
  // prompt is on the hosted CLI's screen, so presence in the freshest fetch is
  // the pending signal — the merged render list can't be used (merges never
  // remove). Feeds pendingPrompts$, which auto-presents the form sheet below.
  const freshest = recentQ.dataUpdatedAt >= fullQ.dataUpdatedAt ? recentQ.data : fullQ.data;
  useEffect(() => {
    if (!live || !tid || !host || !freshest) return;
    const last = freshest[freshest.length - 1];
    if (last?.type === "prompt_request") {
      setPendingPrompt({
        promptId: last.promptId,
        title: last.title,
        kind: last.kind,
        options: last.options,
        highlighted: last.highlighted,
        multiSelect: last.multiSelect,
        hostId: host,
        threadId: tid,
      });
    } else {
      // Only the host that surfaced the prompt may clear it. A second paired
      // bridge on the same machine reads the same transcript but hosts no PTY,
      // so its fetches never carry the synthesized prompt_request — letting it
      // clear here dismissed the sheet while the prompt was still blocking.
      const cur = pendingPrompts$[tid].peek();
      if (!cur || cur.hostId === host) clearPendingPrompt(tid);
    }
  }, [freshest, live, tid, host]);

  // Auto-present the prompt form sheet (a native formSheet route) once per
  // promptId — the answer round-trip can leave the same prompt on screen for a
  // poll or two, and re-pushing would stack sheets. Mobile-only: desktop uses
  // its own navigator (no expo-router routes) and keeps the inline card.
  const pendingPrompt = useSelector(() => pendingPrompts$[id!].get());
  const presentedPromptRef = useRef<string | null>(null);
  useEffect(() => {
    if (DESKTOP || !pendingPrompt) return;
    if (presentedPromptRef.current === pendingPrompt.promptId) return;
    presentedPromptRef.current = pendingPrompt.promptId;
    router.push(`/prompt/${id}`);
  }, [pendingPrompt, id, router]);

  // Loading only until *something* is renderable; failed only if we have nothing
  // and the full fetch errored (a failed recent still falls through to full).
  const loading =
    canFetch && !recentQ.data && !fullQ.data && (recentQ.isLoading || fullQ.isLoading);
  const failed = canFetch && fullQ.isError && !recentQ.data && !fullQ.data;

  const rawEvents = live ? liveEvents : demoTl.events;
  // Timeline collapses paired tool results into their call's accordion, so
  // marker indices must be computed over the same collapsed array it renders.
  const events = useMemo(() => collapseToolResults(rawEvents), [rawEvents]);
  // `loading` goes false the moment the QUERY resolves, but the events it
  // returned are copied into liveEvents by an effect — so for a render or two
  // the fetch is "done" while there is still nothing to draw. Without this the
  // loading state cut out into a blank frame (or a flash of "No messages yet")
  // and the transcript appeared a beat later. Keep waiting while the fetched
  // data says there ARE events but none have landed yet; a genuinely empty
  // thread reports length 0 and falls through to the empty state as before.
  const seeding = canFetch && (freshest?.length ?? 0) > 0 && events.length === 0;
  // Belt and braces for the re-key case above. `onLoad` belongs to the list, not
  // to us; if it is ever missed (a re-key, a recycle, a future list version) the
  // cost is the worst thing this screen can do — cover a drawn transcript with a
  // loading label forever. Once there are events to show, give the list a beat to
  // report in and then uncover regardless.
  // Depends on "are there events", NOT on how many: the raw count changes with
  // every streamed token, which tore down and re-armed this timer each time.
  const hasEvents = events.length > 0;
  useEffect(() => {
    if (listReady || !hasEvents) return;
    const t = setTimeout(() => setListReady(true), 1200);
    return () => clearTimeout(t);
  }, [listReady, hasEvents]);
  // Read at send time to decide whether the scroll-to-end animates (the very
  // first message has nothing to scroll past). A ref, not a dep: threading the
  // event array into runTurn would rebuild it on every streamed token.
  const eventCountRef = useRef(0);
  useEffect(() => {
    eventCountRef.current = events.length;
  }, [events.length]);

  useEffect(() => {
    if (atBottom) {
      // Back at the newest message: nothing is unseen any more.
      setNewWhileAway(false);
      countWhenLeftRef.current = events.length;
      setScrollDir(null);
      return;
    }
    if (events.length > countWhenLeftRef.current) setNewWhileAway(true);
  }, [events.length, atBottom]);

  // The agent's checklist, folded from the newest task call in the thread.
  // Derived ONCE here and shared: the pinned bar below shows `state`, and
  // Timeline needs the same fold to render each task card. Folding it in both
  // places cost two passes over every event per streamed token, and let the two
  // views disagree about which task is current.
  const tasks = useMemo(() => deriveTaskTimeline(rawEvents), [rawEvents]);
  const taskState = tasks.state;
  // Desktop's status line renders the count and owns the toggle; no-op on mobile.
  usePublishTasks(taskState);

  // --- markers: user messages by default, overrides for adds/removals ---
  const listRef = useRef<LegendListRef>(null);
  const composerRef = useRef<ComposerHandle>(null);
  // The composer BAR (a plain View wrapping the composer and everything stacked
  // above it — queued sends, the task bar). The keyboard seam measures it so the
  // transcript can inset for exactly its height; `useChatKeyboard` needs a view
  // it can `measure()`, which the Composer's imperative handle isn't.
  const composerBarRef = useRef<View>(null);
  const { keyboard, onComposerLayout, scrollMessageToEnd, composerHeight } = useChatKeyboard(
    listRef,
    composerBarRef,
  );

  const [markerSheet, setMarkerSheet] = useState(false);
  // Topmost visible row, for the turn rail's "you are here". Only the rail reads
  // it, so it costs nothing on mobile where the rail never mounts.
  const [visibleIndex, setVisibleIndex] = useState<number | undefined>(undefined);
  // Search + "…" are local state on mobile (the screen owns its header) and
  // shell-owned on desktop, where the tab strip renders those buttons instead.
  const {
    searchOpen: threadSearchOpen,
    setSearchOpen: setThreadSearchOpen,
    envOpen: envSheet,
    setEnvOpen: setEnvSheet,
    tasksOpen,
    setTasksOpen,
  } = useSessionChrome();

  // Sources attached to this thread (drag-drop on desktop / "+" in the
  // Environment sheet). Dropping records the reference and appends an @path
  // mention to the draft — the agent reads the file/folder from disk.
  const sources = useSelector(() => sources$[id!].get()) ?? [];
  const onDropFiles = useCallback(
    (files: DroppedFile[]) => {
      if (!session?.isResumable) return;
      const cwd = session.cwd;
      const kindOf = (f: DroppedFile): ThreadSource["kind"] =>
        f.type?.startsWith("image/") || IMAGE_EXT.test(f.name)
          ? "image"
          : !f.type && !/\.[A-Za-z0-9]+$/.test(f.name)
            ? "dir" // folders report no MIME type and (usually) no extension
            : "file";
      // Images become thumbnail attachments (like the photo picker); everything
      // else is referenced as an @path mention the agent reads from disk.
      const withImages = effectiveCaps(session.agent, reportedCaps).images;
      const sources: ThreadSource[] = [];
      const images: { path: string; mediaType: string }[] = [];
      const mentions: string[] = [];
      for (const f of files) {
        const kind = kindOf(f);
        // Mention paths relative to the worktree read better; anything outside
        // it stays absolute (the agent can read either).
        const rel = cwd && f.path.startsWith(`${cwd}/`) ? f.path.slice(cwd.length + 1) : f.path;
        sources.push({ path: rel, name: f.name, kind });
        if (kind === "image" && withImages)
          images.push({ path: f.path, mediaType: f.type || mimeForImage(f.name) });
        else mentions.push(rel);
      }
      addSources(session.id, sources);
      if (images.length) composerRef.current?.attachImages(images);
      if (mentions.length) composerRef.current?.addMentions(mentions);
    },
    [session?.isResumable, session?.cwd, session?.id, session?.agent, reportedCaps],
  );
  // Marker overrides for this thread, live from the collection so the list
  // recomputes on every toggle.
  const markerMap = useThreadMarkers(id);
  const markers = useMemo<Marker[]>(
    () =>
      events.flatMap((e, index) => {
        if (e.type !== "user_message" && e.type !== "assistant_message") return [];
        // Only prose is marker-worthy: a plain message, or a command with an
        // accompanying message. A bare slash command (/exit, /clear) has no text,
        // so it's never auto-marked.
        if (!(markerMap.get(e.id) ?? defaultMarked(e, session?.agent))) return [];
        return [{ id: e.id, index, type: e.type, text: e.text, ts: e.ts }];
      }),
    [events, markerMap, session?.agent],
  );

  const jumpTo = useCallback((index: number) => {
    listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.1 });
  }, []);

  /** Index of the rendered event closest in time to `iso` — search hits are
   *  located by their message timestamp, not by event id (ctx ids are its
   *  own). Rows whose text actually CONTAINS the term win over closer rows
   *  that don't, so the highlight always lands on a term-bearing row even
   *  when clock skew or collapsed tool results shift the nearest neighbour. */
  const findNearestIndex = useCallback(
    (iso: string | null | undefined, term?: string) => {
      const target = iso ? Date.parse(iso) : Number.NaN;
      if (Number.isNaN(target)) return -1;
      const needle = term?.toLowerCase();
      let best = -1;
      let bestDiff = Number.POSITIVE_INFINITY;
      let bestWithTerm = -1;
      let bestWithTermDiff = Number.POSITIVE_INFINITY;
      for (let i = 0; i < events.length; i++) {
        const ev = events[i];
        const ts = ev.ts ? Date.parse(ev.ts) : Number.NaN;
        if (Number.isNaN(ts)) continue;
        const diff = Math.abs(ts - target);
        if (diff < bestDiff) {
          bestDiff = diff;
          best = i;
        }
        if (needle && diff < bestWithTermDiff) {
          const text = "text" in ev ? (ev as { text?: string }).text : undefined;
          if (text?.toLowerCase().includes(needle)) {
            bestWithTermDiff = diff;
            bestWithTerm = i;
          }
        }
      }
      // A term-bearing row within 2 minutes of the hit beats the raw nearest.
      return bestWithTerm >= 0 && bestWithTermDiff < 120_000 ? bestWithTerm : best;
    },
    [events],
  );

  // Search-hit deep link: once the FULL history is rendered (the recent-4 page
  // won't contain an old match), scroll to the event nearest `at` and mark it
  // with the matched term. Once per mount; the delay lets the list finish its
  // initial layout first.
  const didJumpToAt = useRef(false);
  const [searchHighlight, setSearchHighlight] = useState<
    { id: string; term: string } | undefined
  >();
  useEffect(() => {
    if (!at || didJumpToAt.current || !fullQ.data || events.length === 0) return;
    didJumpToAt.current = true;
    const best = findNearestIndex(String(at), q ? String(q) : undefined);
    if (best >= 0) {
      if (q) setSearchHighlight({ id: events[best].id, term: String(q) });
      // Repeatedly: the timeline's own open-at-bottom anchoring can land AFTER
      // the first jump and silently win, and on long threads scrollToIndex
      // over unmeasured history is approximate — later jumps correct the
      // estimate as items measure. scrollToIndex is idempotent.
      setTimeout(() => jumpTo(best), 350);
      setTimeout(() => jumpTo(best), 1300);
      setTimeout(() => jumpTo(best), 2800);
    }
  }, [at, q, fullQ.data, events, findNearestIndex, jumpTo]);

  // --- In-thread search: header toggle, debounced query against this thread's
  // history index (event-level hits), prev/next hop with yellow highlight.
  const [threadQuery, setThreadQuery] = useState("");
  const [threadHits, setThreadHits] = useState<MessageSearchHit[]>([]);
  const [threadHitIdx, setThreadHitIdx] = useState(0);
  const [threadSearching, setThreadSearching] = useState(false);
  const threadGen = useRef(0);
  const goToHit = useCallback(
    (hits: MessageSearchHit[], idx: number, term: string) => {
      if (!hits.length) return;
      const clamped = ((idx % hits.length) + hits.length) % hits.length;
      setThreadHitIdx(clamped);
      const ei = findNearestIndex(hits[clamped].timestamp, term);
      if (ei >= 0) {
        setSearchHighlight({ id: events[ei].id, term });
        jumpTo(ei);
      }
    },
    [events, findNearestIndex, jumpTo],
  );
  useEffect(() => {
    const t = threadQuery.trim();
    const gen = ++threadGen.current;
    if (!threadSearchOpen || t.length < 3 || !session?.hostId || !id) {
      setThreadHits([]);
      setThreadSearching(false);
      return;
    }
    setThreadSearching(true);
    const timer = setTimeout(async () => {
      const hits = await searchMessages(t, {
        thread: id,
        agent: session.agent,
        hostId: session.hostId,
        limit: 50,
      }).catch(() => []);
      if (threadGen.current !== gen) return;
      setThreadHits(hits);
      setThreadSearching(false);
      goToHit(hits, 0, t);
    }, 350);
    return () => clearTimeout(timer);
    // goToHit changes with every event refresh; re-running the search then
    // would spam the bridge for nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadSearchOpen, threadQuery, session?.hostId, session?.agent, id]);
  // `setThreadSearchOpen` comes from the chrome seam, not useState — it isn't a
  // guaranteed-stable identity, so it has to be a dependency.
  const closeThreadSearch = useCallback(() => {
    setThreadSearchOpen(false);
    setThreadQuery("");
    setThreadHits([]);
    setSearchHighlight(undefined);
  }, [setThreadSearchOpen]);

  const onLongPressEvent = useCallback(
    (ev: TimelineEvent) => {
      // Optimistic ids are replaced on refetch — a toggle here would orphan.
      if (ev.id.startsWith("opt:")) return;
      // Mirror every toggle to the machine that owns the thread, so a second
      // device (and the bridge's own consumers) see it. Best-effort by design.
      const toggle = () => {
        const next = toggleMarker(id!, ev, session?.agent);
        if (host) void pushMarker(host, id!, ev.id, next);
      };
      // Desktop skips the menu entirely — long-press toggles the marker
      // directly, since a two-item NSAlert for one verb is more chrome than
      // choice.
      if (DESKTOP) {
        toggle();
        return;
      }
      const marked = isMarked(id!, ev, session?.agent);
      const text = "text" in ev ? (ev as { text?: string }).text : undefined;
      const options = [marked ? "Remove marker" : "Add marker"];
      if (text) options.push("Copy text");
      // pickSheet, not ActionSheetIOS: the latter is iOS-only and this menu
      // simply never opened on Android. It appends its own cancel affordance.
      pickSheet(undefined, options, (i) => {
        if (i === 0) toggle();
        else if (i === 1 && text) Clipboard.setString(text);
      });
    },
    [id, host, session?.agent],
  );

  // One message → one streamed turn. Only pre-delivery errors propagate (so the
  // Composer restores the user's draft); once the host has the turn, failures
  // in streaming/refetching are swallowed and sync catches up.
  const runTurn = useCallback(
    // `model` only ever arrives on the FIRST turn, handed over by the New
    // screen — see PendingTurn.model for why it can't come from the store yet.
    async (s: ComposerSubmit & { model?: string | null }) => {
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
        // Anchor the timeline to this message: it rises to the top of the
        // viewport and the reply streams into the space reserved below it (see
        // Timeline.anchorToId). The scroll that puts it there is coordinated
        // with the keyboard closing, so the two don't fight; on the very first
        // message there is nothing to scroll past, so it isn't animated.
        setAnchorId(optimistic.id);
        scrollMessageToEnd({ animated: eventCountRef.current > 0, closeKeyboard: true });
        // Interactive thread: drive the hosted PTY (the bridge reuses its live PTY
        // or `--resume`s the SAME session) so prompts stay answerable and no new
        // session is spawned. PTY turns don't stream over SSE, so echo the message
        // and poll the transcript — the synthesized prompt_request / reply lands
        // there — rather than wait on the 20s workspace sync.
        if (isThreadInteractive(session.id)) {
          setLiveEvents((e) => mergeById(e, [optimistic]));
          await startInteractive(session.hostId, s.text, session.cwd, session.id);
          // The render seeds from full ▸ recent history, so refetch both — the
          // submit lands over a few seconds (see submitPrompt), so poll a handful
          // of times to surface the reply / question card promptly.
          for (const ms of [1500, 2500, 4000, 6000]) {
            await new Promise((r) => setTimeout(r, ms));
            await Promise.all([recentQ.refetch(), fullQ.refetch()]).catch(() => {});
          }
          return;
        }
        setLiveEvents((e) => mergeById(e, [optimistic]));
        // Everything the turn streams, kept so the post-turn refetch can't erase
        // it: the turn's `done` can resolve before the host has flushed the last
        // assistant line to the transcript, so a re-parse may briefly miss it.
        const turnEvents: TimelineEvent[] = [];
        // The daemon only streams frames once it has accepted the turn, so the
        // first event marks the message as delivered. After that point an error
        // (cellular blip mid-stream, post-turn refetch) must NOT propagate to the
        // Composer — restoring the draft for a message the agent is already
        // working on is how sent text "reappeared" in the input box.
        let delivered = false;
        let threadId: string | null = null;
        try {
          ({ threadId } = await streamLiveMessage(
            session.hostId,
            session.agent,
            session.id,
            session.cwd,
            s.text,
            (ev) => {
              delivered = true;
              turnEvents.push(ev);
              setLiveEvents((e) => {
                // The daemon echoes the user turn as it streams; drop our optimistic
                // placeholder then so the message isn't shown twice.
                const base =
                  ev.type === "user_message" && !ev.id.startsWith("opt:")
                    ? e.filter((x) => !x.id.startsWith("opt:"))
                    : e;
                return mergeById(base, [ev]);
              });
            },
            {
              images: s.images,
              permissionMode:
                modesFor(session.agent).length > 1
                  ? (mode ?? modesFor(session.agent)[0]?.value)
                  : undefined,
              reasoningEffort: effectiveCaps(session.agent, capsFor(session.agent)).thinking
                ? effort
                : undefined,
              model: s.model ?? modelForThread(session.id),
            },
          ));
        } catch (err) {
          if (!delivered) {
            // The turn never reached the host: drop the optimistic echo and let
            // the error propagate so the Composer restores the draft.
            setLiveEvents((e) => e.filter((x) => x.id !== optimistic.id));
            throw err;
          }
          // Delivered — the host keeps working even though our stream dropped.
          // The sync tick refetches the transcript, so just stop streaming.
          return;
        }
        if (threadId) {
          // fresh: the host's message cache can predate this turn. And if the
          // re-parse STILL misses streamed events (transcript flush lag), keep
          // them — replacing the list with an incomplete fetch made the reply
          // vanish right as the turn finished. Best-effort: the turn is already
          // delivered, so a refetch failure must not bubble up and restore the
          // draft — the streamed events stay on screen and sync catches up.
          try {
            const fetched = await fetchMessages(session.hostId, session.agent, threadId, {
              fresh: true,
            });
            // Older history is id-stable across fetches; only this turn's
            // streamed rows need their identity preserved (see reconcileFetched).
            const merged = reconcileFetched(turnEvents, chrono(fetched));
            setLiveEvents(merged);
            saveThreadMessages(threadId, merged); // one persist per completed turn
          } catch {
            // Refetch failed but the turn happened — persist what we streamed so
            // the rekey below (which remounts the route) doesn't blank the thread.
            if (turnEvents.length) saveThreadMessages(threadId, chrono(turnEvents));
          }
        }
        refreshUsage();
        // A freshly-created task carries a temporary `new_*` id the daemon doesn't
        // know. Once the first turn returns the real thread id, re-key the local
        // session onto it — otherwise the session stays orphaned ("Queued"
        // forever, empty on reopen) while sync surfaces the real thread as a
        // separate entry. The screen follows via the rekeyedThreadIds$ alias; no
        // route replace (a remount would blank the just-finished reply).
        if (threadId && threadId !== session.id && session.id.startsWith("new_")) {
          rekeyThread(session.id, { ...session, id: threadId, activity: "idle" });
        }
      } else {
        const { getRuntime } = await import("../services/runtime");
        const rt = await getRuntime();
        await rt.sendMessage({
          conversation: { id: session.id, agent: session.agent, threadId: session.id } as never,
          project: { path: session.cwd ?? "" } as never,
          text: s.text,
        });
      }
    },
    [session, live, refreshUsage, mode, effort, recentQ, fullQ, scrollMessageToEnd],
  );

  // Follow-ups typed while a turn runs are queued and drained in order — the
  // Claude Code / Codex model. inFlightRef gates re-entrancy synchronously so a
  // fast second submit can't start a parallel turn before `sending` updates.
  const inFlightRef = useRef(false);
  /** When a turn WE ran finished, or null if we've never run one here. Beats
   *  the synced record, which lags — see `running` below. */
  const turnEndedAt = useRef<number | null>(null);
  const queueRef = useRef<ComposerSubmit[]>([]);
  const [queued, setQueued] = useState<ComposerSubmit[]>([]);

  // Mirror externally-driven activity (a terminal Claude Code session working
  // this thread, a /compact, …): every sync bumps the thread's updatedAt when
  // its transcript changes on the host, so refetch history then. Skipped while
  // a local turn streams — it appends its own events and fetches on finish.
  const remoteTick = session?.updatedAt;
  useEffect(() => {
    if (!canFetch || inFlightRef.current) return;
    void recentQ.refetch();
    void fullQ.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remoteTick]);

  const onSubmit = useCallback(
    async (s: ComposerSubmit) => {
      if (inFlightRef.current) {
        queueRef.current = [...queueRef.current, s];
        setQueued(queueRef.current);
        return;
      }
      inFlightRef.current = true;
      // A new turn supersedes what we knew about the last one.
      turnEndedAt.current = null;
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
        // First-hand: this turn is over. Held until the record catches up (or
        // a genuinely new turn arrives), so the stale "running" it still
        // reports can't re-animate a finished turn.
        turnEndedAt.current = Date.now();
        setSending(false);
      }
    },
    [runTurn],
  );

  /**
   * Tapping "Run" on a command block: execute it on the HOST, then tell the
   * agent what happened.
   *
   * It used to prefill the composer with `!cmd` — Claude's REPL bang prefix,
   * which does nothing on the headless path we drive (`claude -p`), so it
   * arrived as a message starting with "!" and the agent decided what to make
   * of it. This runs the command for real through /v1/exec: same shell, same
   * cwd, deterministic, no model in the loop.
   *
   * The result is then relayed as a turn, because an agent that doesn't know
   * the command ran will offer it again — the transcript has to stay a true
   * record of what happened on the machine.
   */
  const onRunCommand = useCallback(
    async (cmd: string) => {
      if (!session) return null;
      const r = await runExec(session.hostId, session.cwd, cmd.trim());
      // Bounded: a turn carrying 100kB of build log is unreadable and expensive.
      // The full output stays on screen in the card.
      const shown = r.output.length > 4000 ? `${r.output.slice(0, 4000)}\n… (truncated)` : r.output;
      void onSubmit({
        text:
          `I ran this command and got exit code ${r.code}:\n\n` +
          `\`\`\`bash\n${cmd.trim()}\n\`\`\`\n\n` +
          (shown.trim() ? `Output:\n\n\`\`\`\n${shown.trim()}\n\`\`\`` : "It printed nothing."),
        images: [],
      });
      return r;
    },
    [session, onSubmit],
  );

  const cancelQueued = useCallback((i: number) => {
    queueRef.current = queueRef.current.filter((_, n) => n !== i);
    setQueued(queueRef.current);
  }, []);

  /**
   * Send a follow-up the drain never reached.
   *
   * A turn that THROWS leaves the loop through the exception, so anything still
   * queued behind it stays there with nothing left to drain it — and, before
   * this, still captioned "sends after the current reply". Deliberately manual:
   * re-running automatically after a failure is how one broken turn becomes
   * five.
   */
  const sendQueued = useCallback(
    (i: number) => {
      const item = queueRef.current[i];
      if (!item) return;
      queueRef.current = queueRef.current.filter((_, n) => n !== i);
      setQueued(queueRef.current);
      void onSubmit(item);
    },
    [onSubmit],
  );

  // A send can strand: if the turn lands somewhere other than this thread (a
  // resume that forks into its own session, say) the host echo never arrives,
  // so the optimistic row would sit at "Sending…" forever. Timeline offers a
  // Retry once that times out — drop the dead echo first so a successful
  // resend doesn't leave the thread showing the message twice.
  const onRetrySend = useCallback(
    (ev: TimelineEvent) => {
      const text = ev.type === "user_message" ? ev.text : "";
      setLiveEvents((e) => e.filter((x) => x.id !== ev.id));
      if (text.trim()) void onSubmit({ text, images: [] });
    },
    [onSubmit],
  );

  const stop = useCallback(async () => {
    if (!session) return;
    // Cancel pending follow-ups and halt the drain loop, then interrupt the turn.
    queueRef.current = [];
    setQueued([]);
    inFlightRef.current = false;
    await interruptTurn(session.hostId, session.agent, session.id);
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

  /**
   * Is a turn actually in flight?
   *
   * `sending` is DEFINITIVE for a turn this screen started: runTurn resolved,
   * so the agent is done, full stop. `session.activity` is the synced record,
   * which lags — it is how a MIRRORED turn (started on the Mac) is seen at all,
   * but after our own turn ends it keeps reading "running" until the next sync
   * and would leave the composer animating over a finished turn.
   *
   * So the local answer wins once we've had one: only trust the record while
   * this screen has no first-hand knowledge.
   */
  const mirrored = session?.activity === "running" || session?.activity === "streaming";
  // The stamp only outranks a record that hasn't moved since. Once the host
  // reports anything NEWER than our turn's end — the catch-up sync, or a fresh
  // turn started on the Mac — the record is first-hand again and wins.
  const staleRunning =
    turnEndedAt.current != null &&
    !(session?.updatedAt && Date.parse(session.updatedAt) > turnEndedAt.current);
  const running = sending || (mirrored && !staleRunning);

  // Working-tree +/- totals for the composer's diff shortcut. Refreshed when
  // a turn starts/ends (`running` flips) — that's when the working tree moves.
  // This block sits ABOVE the not-found return: `session` can flicker to
  // undefined during sync reconcile on a brand-new thread, and hooks below an
  // early return crash React ("Rendered fewer hooks than expected").
  const [diffStat, setDiffStat] = useState<{ add: number; del: number } | null>(null);
  useEffect(() => {
    if (!session?.cwd) return;
    let cancelled = false;
    fetchGitChanges(session.hostId, session.cwd)
      .then((g) => {
        if (!cancelled) setDiffStat(diffTotals(g.files));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [session?.hostId, session?.cwd, running]);
  // Send-anchor lifecycle end: once the turn completes, drop the anchor —
  // Timeline removes its spacer and restores maintainScrollAtEnd, whose own
  // near-end gate keeps a scrolled-up reader in place (no yank, no jump).
  useEffect(() => {
    if (!running) setAnchorId(null);
  }, [running]);

  if (!session) {
    return (
      <View style={s.notFound}>
        <Text style={s.notFoundText}>Session not found.</Text>
      </View>
    );
  }

  /**
   * Whether the composer accepts input at all.
   *
   * This is "the thread can be resumed", nothing more. It was named `canSend`
   * while reading `isLive`, which promised something the app cannot do: there
   * is no mid-turn steer path (the bridge can only write into a PTY-hosted
   * session's prompt), so a follow-up typed during a turn is queued locally and
   * sent when the turn ends. Naming it for what it is stops the composer
   * offering to steer.
   */
  const canSend = session.isResumable;
  const caps = effectiveCaps(session.agent, reportedCaps);
  // Turn start = the newest user message; drives the elapsed readout in the
  // composer's pill row. Output tokens are estimated at ~4 chars/token —
  // approximate (it can't see hidden reasoning tokens), and jumpy on mirrored
  // sessions whose transcript only lands text on message completion.
  let turnStartTs: string | undefined;
  let turnStartIdx = rawEvents.length;
  for (let i = rawEvents.length - 1; i >= 0; i--) {
    if (rawEvents[i].type === "user_message") {
      turnStartTs = rawEvents[i].ts;
      turnStartIdx = i;
      break;
    }
  }
  let outChars = 0;
  for (let i = turnStartIdx + 1; i < rawEvents.length; i++) {
    const e = rawEvents[i];
    if (e.type === "assistant_message") outChars += e.text.length;
    else if (e.type === "thinking_finished") outChars += (e.text ?? "").length;
  }
  const turnTokens = Math.round(outChars / 4);

  // Permission-mode + reasoning-effort controls (shown on the status bar).
  const modes = modesFor(session.agent);
  const showMode = modes.length > 1;
  const showEffort = caps.thinking;
  const activeMode = mode ?? modes[0]?.value;
  const modeLabel =
    activeMode === "default"
      ? "Mode"
      : (modes.find((m) => m.value === activeMode)?.label ?? "Mode");
  const effortLabel = REASONING_EFFORTS.find((e) => e.value === effort)?.label ?? "Effort";
  const openMode = () =>
    pickSheet(
      "Mode",
      modes.map((m) => `${m.label} · ${m.hint}`),
      (i) => setMode(modes[i].value),
    );
  const openEffort = () =>
    pickSheet(
      "Reasoning effort",
      REASONING_EFFORTS.map((e) => e.label),
      (i) => setEffort(REASONING_EFFORTS[i].value),
    );

  // Combined model·effort pill label for the composer, e.g. "opus 4.7 · High".
  const activeModel = selectedModel ?? usage?.model ?? null;
  const modelName = activeModel ? shortModel(activeModel) : "Model";
  const modelPillLabel =
    showEffort && effort && effort !== "off" ? `${modelName} · ${effortLabel}` : modelName;

  // Session actions now live in the Environment sheet — the "…" button opens it.

  return (
    // No KeyboardAvoidingView any more. On mobile the transcript is a
    // keyboard-aware list and the composer rides the keyboard in its own sticky
    // view — both on the UI thread, so the two move in the same frame instead of
    // JS re-laying-out this whole screen per keyboard event. Desktop has no
    // software keyboard, so it never needed one.
    <View style={s.root}>
      <Stack.Screen options={{ headerShown: false }} />
      {/* Desktop: the whole pane is a drop target — dragging files/folders from
          Finder adds them as sources. No-op wrapper on mobile. */}
      <DropZone style={{ flex: 1 }} onDropFiles={onDropFiles}>
        {/* Header. Desktop has none: the tab carries the title and the live
            agent glyph, the status bar carries branch/checkout/usage, and the
            tab strip carries search and "…". A header here would just say all
            of it a second time. Only the find-in-thread bar remains, and only
            while it's open. */}
        <View style={[s.header, DESKTOP ? s.headerDesktop : s.headerPad]}>
          {!DESKTOP ? (
            <View style={s.headerRow}>
              {/* Desktop's sidebar is always visible — a back button has nothing
              to go back to, so it's mobile-only. */}
              {!DESKTOP ? (
                <Pressable
                  onPress={() => router.back()}
                  style={({ pressed }) => [s.iconBtn, pressed && s.pressed60]}
                >
                  {/* The system's own chevron, not a typographic "‹": that was
                      a font character sitting among SF Symbols, which is
                      exactly what made this header look mismatched. */}
                  <PounceIcon name="chevron-back" size={HEADER_ICON} color={theme.colors.fg} />
                </Pressable>
              ) : null}
              <View style={s.flex1}>
                {!DESKTOP ? (
                  <Text numberOfLines={1} style={s.headerTitle}>
                    {session.title}
                  </Text>
                ) : null}
                <View style={s.headerSubRow}>
                  {session.branch ? (
                    <View style={s.shrink}>
                      <BranchChip
                        branch={session.branch}
                        worktree={session.worktree}
                        size={10}
                        color={theme.colors.fgFaint}
                      />
                    </View>
                  ) : null}
                  <ThreadUsageSummary usage={usage} />
                </View>
              </View>
              {/* Favourite + markers live in the "…" sheet — the header stays
              back / title / search / more. */}
              <Pressable
                onPress={() => (threadSearchOpen ? closeThreadSearch() : setThreadSearchOpen(true))}
                style={({ pressed }) => [s.iconBtn, pressed && s.pressed60]}
              >
                <PounceIcon
                  name="search"
                  size={HEADER_ICON}
                  color={threadSearchOpen ? theme.colors.accent : theme.colors.fgMuted}
                />
              </Pressable>
              <Pressable
                onPress={() => setEnvSheet(true)}
                style={({ pressed }) => [s.iconBtn, pressed && s.pressed60]}
              >
                <PounceIcon
                  name="ellipsis-horizontal"
                  size={HEADER_ICON}
                  color={running ? theme.colors.danger : theme.colors.fgMuted}
                />
              </Pressable>
            </View>
          ) : null}
          {threadSearchOpen ? (
            <View style={[s.searchRow, DESKTOP && s.searchRowDesktop]}>
              <View style={[s.searchField, DESKTOP && s.searchFieldDesktop]}>
                <PounceIcon name="search" size={DESKTOP ? 14 : 16} color={theme.colors.fgFaint} />
                <TextInput
                  {...INPUT_TWEAKS}
                  value={threadQuery}
                  onChangeText={setThreadQuery}
                  placeholder="Find in this thread…"
                  placeholderTextColor={theme.colors.fgFaint}
                  autoFocus
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={[s.searchInput, DESKTOP && s.searchInputDesktop]}
                />
                {threadSearching ? (
                  <ActivityIndicator size="small" color={theme.colors.fgFaint} />
                ) : threadQuery.trim().length >= 3 ? (
                  <Text style={s.hitCount}>
                    {threadHits.length ? `${threadHitIdx + 1}/${threadHits.length}` : "0"}
                  </Text>
                ) : null}
              </View>
              <Pressable
                disabled={!threadHits.length}
                onPress={() => goToHit(threadHits, threadHitIdx - 1, threadQuery.trim())}
                style={({ pressed }) => [
                  s.hitBtn,
                  DESKTOP && s.hitBtnDesktop,
                  pressed && s.pressed60,
                ]}
              >
                <PounceIcon
                  name="chevron-up"
                  size={DESKTOP ? 14 : 17}
                  color={threadHits.length ? theme.colors.fgMuted : theme.colors.fgFaint}
                />
              </Pressable>
              <Pressable
                disabled={!threadHits.length}
                onPress={() => goToHit(threadHits, threadHitIdx + 1, threadQuery.trim())}
                style={({ pressed }) => [
                  s.hitBtn,
                  DESKTOP && s.hitBtnDesktop,
                  pressed && s.pressed60,
                ]}
              >
                <PounceIcon
                  name="chevron-down"
                  size={DESKTOP ? 14 : 17}
                  color={threadHits.length ? theme.colors.fgMuted : theme.colors.fgFaint}
                />
              </Pressable>
              {/* Desktop needs its own dismiss: the toggle that opened this
                  lives up in the tab strip, which is a long way to travel to
                  close a bar that's right here. */}
              {DESKTOP ? (
                <Pressable
                  onPress={closeThreadSearch}
                  style={({ pressed }) => [s.hitBtn, s.hitBtnDesktop, pressed && s.pressed60]}
                >
                  <PounceIcon name="close" size={14} color={theme.colors.fgMuted} />
                </Pressable>
              ) : null}
            </View>
          ) : null}
        </View>

        <View style={s.transcriptArea}>
          {/* One readable column for every transcript-area state. Desktop:
            proportional (92% of the pane, capped) so the chat adapts to the
            window; mobile: full width, unchanged. */}
          <View style={[s.flex1, DESKTOP ? { width: "92%", maxWidth: 900 } : { width: "100%" }]}>
            {(loading || seeding) && events.length === 0 ? (
              // One quiet line, centered. The bubble skeleton that used to sit
              // here promised a shape the Timeline doesn't actually render —
              // threads are mostly tool accordions, code cards and diffs, not
              // alternating chat bubbles — so it read as a layout that never
              // arrived. A label makes no claim about the content.
              // Sits at the BOTTOM, where the transcript actually opens
              // (alignItemsAtEnd + initialScrollAtEnd), so the line is already
              // standing where the first messages will appear instead of
              // hovering mid-screen and then vanishing somewhere else.
              // Fades OUT as the transcript fades in (which enters on the same
              // 260ms) — the two overlap into a cross-fade instead of the label
              // being yanked off screen a beat before the messages arrive.
              <Animated.View
                entering={FadeIn.duration(200)}
                exiting={FadeOut.duration(240)}
                style={[
                  ANIM.loadingWrap,
                  // The transcript area runs the full height of the screen with
                  // the composer floating over it, so bottom-aligned content
                  // has to clear the composer by hand — this is the same inset
                  // the list gets from contentInsetEndAdjustment. Desktop keeps
                  // the composer in flow, so there it's nothing to clear.
                  {
                    paddingBottom:
                      (COMPOSER_OVERLAYS_LIST ? composerHeight - SCRIM_HEIGHT : 0) + 12,
                  },
                ]}
              >
                <ShimmerLabel text="Loading conversation…" />
              </Animated.View>
            ) : live && failed && events.length === 0 ? (
              <View style={s.emptyWrap}>
                <PounceIcon name="cloud-offline-outline" size={34} color={theme.colors.fgFaint} />
                <Text style={s.emptyTitle}>Couldn't load this conversation</Text>
                <Text style={s.emptyBody}>
                  Make sure {session.host || "your computer"} is awake and the Pounce Bridge is
                  running on the same Wi‑Fi.
                </Text>
                <Pressable
                  onPress={retry}
                  style={({ pressed }) => [s.retryBtn, pressed && s.pressed80]}
                >
                  <Text style={s.retryLabel}>Retry</Text>
                </Pressable>
              </View>
            ) : events.length === 0 ? (
              <View style={s.emptyWrap}>
                <Text style={s.emptyEmoji}>💬</Text>
                <Text style={s.emptyTitle}>No messages yet</Text>
                <Text style={s.emptyBody}>Send a message below to get this thread going.</Text>
              </View>
            ) : (
              // Fade the history in so it doesn't snap in after the skeleton.
              <Animated.View style={ANIM.flex1} entering={FadeIn.duration(260)}>
                {/* The list is mounted from the first frame, but on a long
                    thread its initial render lands SECONDS later and it paints
                    nothing until then — a black screen people reasonably read
                    as a hang. Cover it with the same loading line until the
                    list says it is ready. Note this is NOT the empty-thread
                    branch above: events are already present here, which is why
                    that branch never showed for a real thread. */}
                {!listReady ? (
                  <Animated.View
                    exiting={FadeOut.duration(240)}
                    pointerEvents="none"
                    style={[
                      ANIM.loadingOverlay,
                      {
                        // The platform-adaptive token, NOT a hex derived from
                        // useColorScheme(): the in-app appearance override moves
                        // the JS scheme without moving the native trait, and a
                        // full-bleed overlay that disagrees paints a white panel
                        // into a dark app.
                        backgroundColor: COLOR.bg,
                        // Just above the visible bar. composerHeight includes
                        // the scrim band, which is transparent at its top — sitting
                        // above THAT left the label floating in open space.
                        paddingBottom:
                          (COMPOSER_OVERLAYS_LIST ? composerHeight - SCRIM_HEIGHT : 0) + 12,
                      },
                    ]}
                  >
                    <ShimmerLabel text="Loading conversation…" />
                  </Animated.View>
                ) : null}
                <View style={s.listRow}>
                  <Timeline
                    events={rawEvents}
                    tasks={tasks}
                    agent={session.agent}
                    cwd={session.cwd}
                    sessionId={id!}
                    listRef={listRef}
                    keyboard={keyboard}
                    onReady={() => {
                      setListReady(true);
                      // Opening a thread lands at the newest message. The list can
                      // momentarily report the end as out of view while it settles,
                      // which is not the user having scrolled away — don't let it
                      // raise the Latest pill over the last message.
                      setAtBottom(true);
                    }}
                    onScrollDirection={setScrollDir}
                    onVisibleIndex={TURN_RAIL && IS_DESKTOP ? setVisibleIndex : undefined}
                    highlight={searchHighlight}
                    anchorToId={anchorId}
                    onLongPressEvent={onLongPressEvent}
                    onRunCommand={canSend ? onRunCommand : undefined}
                    onRetrySend={canSend ? onRetrySend : undefined}
                    onAtBottomChange={setAtBottom}
                    onRespondPermission={(requestId, optionId) => {
                      if (session?.hostId)
                        void respondPermission(session.hostId, requestId, optionId);
                    }}
                    onRespondPrompt={(_promptId, optionIndex) => {
                      if (session?.hostId && id)
                        void respondPrompt(session.hostId, id, optionIndex);
                    }}
                    onSendInput={(data) => {
                      if (session?.hostId && id) void sendSessionInput(session.hostId, id, data);
                    }}
                    footer={
                      running
                        ? // "Working" moved into the composer's pill row as dots
                          // (components/WorkingDots.tsx) — a word in the
                          // transcript claimed a line of the conversation to say
                          // what a pulse says without one.
                          undefined
                        : undefined
                    }
                  />
                  {/* Beside the transcript, not over it: a rail that floats on top
                    would sit on the text at narrow widths. Desktop only — the
                    preview is a hover, and a phone has no pointer. */}
                  {TURN_RAIL && IS_DESKTOP ? (
                    <TurnRail
                      markers={markers}
                      agent={session.agent}
                      visibleIndex={visibleIndex}
                      onJump={jumpTo}
                    />
                  ) : null}
                </View>
              </Animated.View>
            )}
          </View>
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
          sources={sources}
          fav={fav}
          onToggleFavourite={canFavourite ? () => toggleFavThread(session.id) : undefined}
          onClose={() => setEnvSheet(false)}
          onStop={() => void stop()}
          onViewChanges={() => router.push(`/changes?id=${session.id}`)}
          onTerminal={() => router.push(`/terminal?id=${session.id}`)}
          onAddSource={canSend ? () => composerRef.current?.startMention() : undefined}
          onRemoveSource={(p) => removeSource(session.id, p)}
          onFixConflicts={
            canSend
              ? () =>
                  composerRef.current?.insert(
                    "Resolve the merge conflicts in this worktree, then continue.",
                  )
              : undefined
          }
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
            const name =
              cachedModels(session.hostId, session.agent)?.find((m) => m.id === modelId)?.name ??
              modelId;
            setLiveEvents((e) =>
              mergeById(e, [
                {
                  id: `switch:${Date.now()}`,
                  conversationId: session.id,
                  seq: Number.MAX_SAFE_INTEGER,
                  ts: new Date().toISOString(),
                  type: "system_event",
                  level: "info",
                  message: `Switched to ${name}. Your next message re-sends the full conversation as context to it (fresh cache).`,
                },
              ]),
            );
          }}
          effort={canSend && showEffort ? { label: effortLabel, onPress: openEffort } : null}
          mode={canSend && showMode ? { label: modeLabel, onPress: openMode } : null}
          onClose={() => setModelSheet(false)}
        />

        {/* Floating "jump to latest" — appears when the bottom of the
          conversation scrolls out of view. It sits above the composer and, on
          mobile, rides up with it when the keyboard opens. */}
        {!atBottom && listReady && events.length > 0 && (scrollDir !== "up" || newWhileAway) ? (
          <ChatKeyboardSticky
            style={[ANIM.jumpWrap, { bottom: composerHeight + 10 }]}
            pointerEvents="box-none"
          >
            <Animated.View entering={ZoomIn.duration(160)} exiting={ZoomOut.duration(140)}>
              <Pressable
                onPress={() => {
                  // Tapping = give up the send anchor: the reserved space drops
                  // and pin-to-tail resumes for the rest of the turn.
                  setAnchorId(null);
                  scrollMessageToEnd({ animated: true });
                  setAtBottom(true);
                }}
                style={({ pressed }) => [s.jumpPill, pressed && s.pressed80]}
              >
                <PounceIcon name="arrow-down" size={15} color={theme.colors.accent} />
                <Text style={s.jumpLabel}>Latest</Text>
              </Pressable>
            </Animated.View>
          </ChatKeyboardSticky>
        ) : null}

        {/* Composer (model·effort, mode, mic and send now live inside its card) —
          same adaptive column as the transcript so they stay aligned.
          Mobile: floats over the transcript inside a keyboard-sticky view; the
          list insets for its measured height so the last message still clears
          it. Desktop: stays in normal flow, exactly as before. */}
        <ChatKeyboardSticky
          style={COMPOSER_OVERLAYS_LIST ? ANIM.composerFloat : undefined}
          pointerEvents="box-none"
        >
          {/* The MEASURED wrapper: scrim + bar. Everything that visually covers
              the transcript has to live in here, because this is the box whose
              height becomes the list's content inset (and the loading label's
              bottom padding). Anything drawn outside it covers content the
              inset thinks is safe. */}
          <View ref={composerBarRef} onLayout={onComposerLayout} pointerEvents="box-none">
            {/* Fades the transcript out as it slides under the composer,
                instead of it being cut off against the opaque bar. */}
            {COMPOSER_OVERLAYS_LIST ? <ComposerScrim /> : null}
            <View style={[s.composerBar, s.composerBarPad]}>
              <View style={DESKTOP ? { width: "92%", maxWidth: 900 } : { width: "100%" }}>
                {!canSend ? (
                  <Text style={s.archivedNote}>
                    Archived session — worktree was removed. Read-only.
                  </Text>
                ) : null}
                {/* Live task progress.
                Mobile: shown for the whole turn, and afterwards only while work
                remains — a finished checklist stays in the transcript rather
                than lingering above the composer.
                Desktop: never opens itself. A banner appearing over the composer
                on every single message is noise; the status line carries the
                count and you open the list when you want it. */}
                {taskState && tasksOpen ? (
                  <TaskProgressBar state={taskState} running={running} />
                ) : null}
                {queued.length > 0 ? (
                  <View style={s.queuedWrap}>
                    {queued.map((q, i) => (
                      <View key={i} style={s.queuedRow}>
                        <PounceIcon
                          name={sending ? "time-outline" : "alert-circle-outline"}
                          size={13}
                          color={sending ? theme.colors.fgFaint : theme.colors.warning}
                        />
                        <Text numberOfLines={1} style={s.queuedText}>
                          {q.text || (q.images.length ? "🖼️ Image" : "")}
                        </Text>
                        {/* Stranded rows get a way out. Tapping sends this one
                            now, which is what the label had been promising. */}
                        {!sending ? (
                          <Pressable onPress={() => sendQueued(i)} hitSlop={8}>
                            <PounceIcon
                              name="arrow-up-circle"
                              size={15}
                              color={theme.colors.accent}
                            />
                          </Pressable>
                        ) : null}
                        <Pressable onPress={() => cancelQueued(i)} hitSlop={8}>
                          <PounceIcon name="close" size={14} color={theme.colors.fgMuted} />
                        </Pressable>
                      </View>
                    ))}
                    {/* The label has to match reality: with no turn in flight
                        nothing is going to drain these, and saying otherwise
                        leaves someone waiting on a message that never went. */}
                    <Text style={s.queuedHint}>
                      {sending
                        ? "Queued — sends after the current reply"
                        : "Not sent — the turn ended before these went"}
                    </Text>
                  </View>
                ) : null}
                <Composer
                  ref={composerRef}
                  agent={session.agent}
                  caps={caps}
                  disabled={!canSend}
                  running={running}
                  turnStartedAt={turnStartTs}
                  turnTokens={turnTokens}
                  hostId={session.hostId}
                  cwd={session.cwd}
                  onSubmit={onSubmit}
                  onStop={stop}
                  onViewChanges={() => router.push(`/changes?id=${session.id}`)}
                  diffStat={diffStat}
                  readOnly={!canSend}
                  // No model selector on an archived thread — the worktree is
                  // gone, so there is no next turn for a model to apply to.
                  model={
                    canSend && live && !!session.cwd
                      ? { label: modelPillLabel, onPress: () => setModelSheet(true) }
                      : null
                  }
                  // Mode lives in the Model sheet now; the pill only appears as a
                  // fallback when there's no model pill to reach that sheet through.
                  mode={
                    canSend && showMode && !(live && !!session.cwd)
                      ? { label: modeLabel, active: activeMode !== "default", onPress: openMode }
                      : null
                  }
                  tasks={
                    taskState?.items.length
                      ? {
                          done: taskState.items.filter((i) => i.status === "completed").length,
                          total: taskState.items.length,
                          open: tasksOpen,
                          onPress: () => setTasksOpen(!tasksOpen),
                        }
                      : null
                  }
                  markers={
                    markers.length
                      ? { count: markers.length, onPress: () => setMarkerSheet(true) }
                      : null
                  }
                  usage={usage}
                />
              </View>
            </View>
          </View>
        </ChatKeyboardSticky>
      </DropZone>
    </View>
  );
}

/** Plain styles for Reanimated views — unistyles sheet entries carry the C++
 *  proxy, which Animated.View rejects ("an empty object is not a valid style
 *  value"). Layout-only, so nothing here needs theme reactivity. */
const ANIM = {
  flex1: { flex: 1 },
  /** `bottom` is supplied per-render — the pill sits just above the composer,
   *  whose height changes as the draft grows and attachments are added. */
  jumpWrap: { position: "absolute", left: 0, right: 0, alignItems: "center" },
  /** Mobile only: the composer floats over the transcript rather than sharing
   *  the column in flex flow, so the list can extend beneath its glass pill and
   *  inset for its exact height. */
  composerFloat: { position: "absolute", left: 0, right: 0, bottom: 0 },
  /** Bottom-left, on the transcript's own padding, so the loading line sits
   *  exactly where the first row of the loaded thread will be. Lives here
   *  rather than in the sheet: Animated.View rejects unistyles entries. */
  loadingWrap: {
    flex: 1,
    justifyContent: "flex-end",
    alignItems: "flex-start",
    paddingHorizontal: 12,
  },
  /** Same placement, but laid OVER the mounted-but-blank list. */
  loadingOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 2,
    justifyContent: "flex-end",
    alignItems: "flex-start",
    paddingHorizontal: 12,
  },
} as const;

const s = StyleSheet.create((theme, rt) => ({
  /** Safe-area padding in the sheet — applied natively, no re-render. */
  headerPad: { paddingTop: rt.insets.top },
  composerBarPad: { paddingBottom: rt.insets.bottom + 8 },
  /** The transcript and the turn rail side by side. The wrapper above this is a
   *  column (it also holds the absolutely-positioned loading overlay), so
   *  without its own row the rail stacked under a flex-1 list and got no
   *  height — present in the tree, zero pixels on screen. */
  listRow: { flex: 1, flexDirection: "row" },
  root: { flex: 1, backgroundColor: theme.colors.bg },
  flex1: { flex: 1 },
  shrink: { flexShrink: 1 },
  pressed60: { opacity: 0.6 },
  pressed80: { opacity: 0.8 },
  notFound: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.bg,
  },
  notFoundText: { color: theme.colors.fgMuted },
  header: {
    borderBottomWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.bgElevated,
  },
  // One tight row on desktop (no title line to make room for) — and no fill,
  // so the transcript reads as one surface from the tab strip down.
  headerDesktop: { backgroundColor: "transparent" },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingBottom: 10,
    paddingTop: 4,
  },
  iconBtn: { height: 36, width: 36, alignItems: "center", justifyContent: "center" },
  headerTitle: { fontSize: 15, fontWeight: "600", color: theme.colors.fg },
  headerSubRow: { marginTop: 2, flexDirection: "row", alignItems: "center", gap: 8 },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 10,
  },
  searchField: {
    height: 36,
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: 12,
    backgroundColor: theme.colors.surfaceAlt,
    paddingHorizontal: 10,
  },
  searchInput: { height: 36, flex: 1, fontSize: 14, color: theme.colors.fg },
  // Desktop find bar: a strip of window chrome, not a phone search field. The
  // 36pt pill with a 12pt radius reads as a form control dropped into the
  // titlebar stack; at 24pt with a hairline border it reads as part of it.
  searchRowDesktop: {
    gap: 4,
    paddingHorizontal: 10,
    paddingTop: 6,
    paddingBottom: 6,
    borderBottomWidth: 1,
    borderColor: theme.colors.border,
  },
  searchFieldDesktop: {
    height: 24,
    gap: 6,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: 7,
  },
  searchInputDesktop: { height: 22, fontSize: 12.5 },
  hitBtnDesktop: { height: 24, width: 24, borderRadius: 5 },
  hitCount: { fontSize: 12, fontVariant: ["tabular-nums"], color: theme.colors.fgMuted },
  hitBtn: { height: 36, width: 32, alignItems: "center", justifyContent: "center" },
  transcriptArea: { flex: 1, alignItems: "center" },
  emptyWrap: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 32 },
  emptyEmoji: { fontSize: 34 },
  emptyTitle: {
    marginTop: 12,
    textAlign: "center",
    fontSize: 15,
    fontWeight: "600",
    color: theme.colors.fg,
  },
  emptyBody: { marginTop: 4, textAlign: "center", fontSize: 13, color: theme.colors.fgMuted },
  retryBtn: {
    marginTop: 20,
    borderRadius: 999,
    backgroundColor: theme.colors.accent,
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  retryLabel: { fontSize: 14, fontWeight: "600", color: theme.colors.onAccent },
  // jumpWrap lives in ANIM (plain object) — its Animated.View can't take sheet entries.
  jumpPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.bgElevated,
    paddingHorizontal: 14,
    paddingVertical: 8,
    shadowColor: "#000",
    shadowOpacity: 0.25,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 4,
  },
  jumpLabel: { fontSize: 13, fontWeight: "600", color: theme.colors.accent },
  // Borderless bar — the Composer's floating glass pill carries its own margins
  // and chrome. It IS filled with the page background though, and has to be:
  // the transcript now runs the full height of the screen underneath it (that's
  // what lets the list own the keyboard inset), so a transparent bar would show
  // the conversation scrolling through the pill and out past the home indicator.
  composerBar: { alignItems: "center", paddingTop: 8, backgroundColor: theme.colors.bg },
  archivedNote: {
    paddingHorizontal: 16,
    paddingBottom: 8,
    fontSize: 12,
    color: theme.colors.fgFaint,
  },
  queuedWrap: { marginHorizontal: 12, marginBottom: 8, gap: 6 },
  queuedRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  queuedText: { flex: 1, fontSize: 12, color: theme.colors.fgMuted },
  queuedHint: { paddingHorizontal: 4, fontSize: 11, color: theme.colors.fgFaint },
}));
