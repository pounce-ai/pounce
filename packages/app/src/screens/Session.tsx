import { useCallback, useEffect, useMemo, useRef, useState } from "react";
// eslint-disable-next-line @react-native/no-deprecated-api -- core Clipboard is
// the only clipboard already inside shipped binaries (OTA-safe).
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Clipboard,
  Pressable,
  Text,
  TextInput,
  View,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Platform } from "react-native";
import { KeyboardAvoidingView } from "../components/kav";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { FadeIn, FadeOut } from "../components/animation";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useSelector } from "@legendapp/state/react";
import { useQuery } from "@tanstack/react-query";
import type { LegendListRef } from "@legendapp/list/react-native";
import type { PermissionMode, TimelineEvent } from "@pounce/shared";
import { collapseToolResults, Timeline } from "../components/Timeline";
import { deriveTaskTimeline } from "../components/taskEvents";
import { TaskProgressBar } from "../components/TaskProgress";
import { WorkingIndicator } from "../components/WorkingIndicator";
import { TimelineSkeleton } from "../components/Skeleton";
import { Composer, type ComposerHandle, type ComposerSubmit } from "../components/Composer";
import { DropZone, type DroppedFile } from "../components/DropZone";
import { MarkerSheet, type Marker } from "../components/MarkerSheet";
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
  fetchUsage,
  interruptTurn,
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
import { ACTIVITY_LABEL, AgentStatusIcon, BranchChip, pickSheet } from "../ui";
import { effectiveCaps, modesFor, REASONING_EFFORTS, type ReasoningEffort } from "../ui/agent-meta";

/** Desktop renders this screen in a wide pane: pickers use Alert instead of
 *  ActionSheetIOS (which doesn't exist there) and the transcript is capped at
 *  a readable column width. */
const DESKTOP = Platform.OS === "macos" || Platform.OS === "windows";

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
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { theme } = useUnistyles();
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);

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
  // acceptEdits/plan/…) so the picker isn't stuck on default. Follows the synced
  // mode as it changes; a local pick sticks until the host's mode next changes.
  useEffect(() => {
    if (session?.permissionMode) setMode(session.permissionMode);
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
  const refreshUsage = useCallback(() => {
    if (!live || !session?.id || session.id.startsWith("new_")) return;
    fetchUsage(session.hostId, session.agent, session.id, session.cwd)
      .then(setUsage)
      .catch(() => {});
  }, [live, session?.hostId, session?.agent, session?.id, session?.cwd]);
  useEffect(() => {
    refreshUsage();
  }, [refreshUsage]);

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
  // The agent's checklist, folded from the newest task call in the thread.
  // Derived ONCE here and shared: the pinned bar below shows `state`, and
  // Timeline needs the same fold to render each task card. Folding it in both
  // places cost two passes over every event per streamed token, and let the two
  // views disagree about which task is current.
  const tasks = useMemo(() => deriveTaskTimeline(rawEvents), [rawEvents]);
  const taskState = tasks.state;

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

  // Sources attached to this thread (drag-drop on desktop / "+" in the
  // Environment sheet). Dropping records the reference and appends an @path
  // mention to the draft — the agent reads the file/folder from disk.
  const sources = useSelector(() => sources$[id!].get()) ?? [];
  const onDropFiles = useCallback(
    (files: DroppedFile[]) => {
      if (!session?.isLive) return;
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
    [session?.isLive, session?.cwd, session?.id, session?.agent, reportedCaps],
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
  const [threadSearchOpen, setThreadSearchOpen] = useState(false);
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
  const closeThreadSearch = useCallback(() => {
    setThreadSearchOpen(false);
    setThreadQuery("");
    setThreadHits([]);
    setSearchHighlight(undefined);
  }, []);

  const onLongPressEvent = useCallback(
    (ev: TimelineEvent) => {
      // Optimistic ids are replaced on refetch — a toggle here would orphan.
      if (ev.id.startsWith("opt:")) return;
      // Desktop has no ActionSheetIOS — long-press toggles the marker directly.
      if (DESKTOP) {
        toggleMarker(id!, ev, session?.agent);
        return;
      }
      const marked = isMarked(id!, ev, session?.agent);
      const text = "text" in ev ? (ev as { text?: string }).text : undefined;
      const options = [marked ? "Remove marker" : "Add marker"];
      if (text) options.push("Copy text");
      options.push("Cancel");
      ActionSheetIOS.showActionSheetWithOptions(
        { options, cancelButtonIndex: options.length - 1 },
        (i) => {
          if (i === 0) toggleMarker(id!, ev, session?.agent);
          else if (i === 1 && text) Clipboard.setString(text);
        },
      );
    },
    [id],
  );

  // One message → one streamed turn. Only pre-delivery errors propagate (so the
  // Composer restores the user's draft); once the host has the turn, failures
  // in streaming/refetching are swallowed and sync catches up.
  const runTurn = useCallback(
    async (s: ComposerSubmit) => {
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
        // Anchor the timeline to this message: it scrolls to the viewport top
        // and the reply streams into the spacer below (see Timeline.anchorToId).
        setAnchorId(optimistic.id);
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
              model: modelForThread(session.id),
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
    [session, live, refreshUsage, mode, effort, recentQ, fullQ],
  );

  // Follow-ups typed while a turn runs are queued and drained in order — the
  // Claude Code / Codex model. inFlightRef gates re-entrancy synchronously so a
  // fast second submit can't start a parallel turn before `sending` updates.
  const inFlightRef = useRef(false);
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
    },
    [runTurn],
  );

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

  const running = sending || session?.activity === "running" || session?.activity === "streaming";

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

  const canSteer = session.isLive;
  const caps = effectiveCaps(session.agent, reportedCaps);
  // The synced thread record lags live turns (short turns never re-sync), so
  // the header trusts the screen's own in-flight state over session.activity.
  const headerActivity = running ? ("running" as const) : session.activity;
  // Turn start = the newest user message; seeds the indicator's verb + elapsed
  // timer. Also estimate output tokens streamed since then (~4 chars/token) for
  // the "↓ N tokens" readout — approximate (it can't see hidden reasoning
  // tokens), and jumpy on mirrored sessions whose transcript only lands text on
  // message completion; smooth for turns started here (they stream live).
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
    <KeyboardAvoidingView
      style={s.root}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={0}
    >
      <Stack.Screen options={{ headerShown: false }} />
      {/* Desktop: the whole pane is a drop target — dragging files/folders from
          Finder adds them as sources. No-op wrapper on mobile. */}
      <DropZone style={{ flex: 1 }} onDropFiles={onDropFiles}>
        {/* Header */}
        <View style={[s.header, { paddingTop: insets.top }]}>
          <View style={s.headerRow}>
            {/* Desktop's sidebar is always visible — a back button has nothing
              to go back to, so it's mobile-only. */}
            {!DESKTOP ? (
              <Pressable
                onPress={() => router.back()}
                style={({ pressed }) => [s.iconBtn, pressed && s.pressed60]}
              >
                <Text style={s.backGlyph}>‹</Text>
              </Pressable>
            ) : null}
            <AgentStatusIcon agent={session.agent} activity={headerActivity} size={18} />
            <View style={s.flex1}>
              <Text numberOfLines={1} style={s.headerTitle}>
                {session.title}
              </Text>
              <View style={s.headerSubRow}>
                {/* "Idle" reads as a broken state to users (the synced record
                    lags live turns, so it shows mid-work) — only surface
                    activity when there's something to say. */}
                {headerActivity !== "idle" ? (
                  <Text style={s.activityLabel}>{ACTIVITY_LABEL[headerActivity]}</Text>
                ) : null}
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
                size={18}
                color={threadSearchOpen ? theme.colors.accent : theme.colors.fgMuted}
              />
            </Pressable>
            <Pressable
              onPress={() => setEnvSheet(true)}
              style={({ pressed }) => [s.iconBtn, pressed && s.pressed60]}
            >
              <PounceIcon
                name="ellipsis-horizontal"
                size={20}
                color={running ? theme.colors.danger : theme.colors.fgMuted}
              />
            </Pressable>
          </View>
          {threadSearchOpen ? (
            <View style={s.searchRow}>
              <View style={s.searchField}>
                <PounceIcon name="search" size={13} color={theme.colors.fgFaint} />
                <TextInput
                  value={threadQuery}
                  onChangeText={setThreadQuery}
                  placeholder="Find in this thread…"
                  placeholderTextColor={theme.colors.fgFaint}
                  autoFocus
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={s.searchInput}
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
                style={({ pressed }) => [s.hitBtn, pressed && s.pressed60]}
              >
                <PounceIcon
                  name="chevron-up"
                  size={17}
                  color={threadHits.length ? theme.colors.fgMuted : theme.colors.fgFaint}
                />
              </Pressable>
              <Pressable
                disabled={!threadHits.length}
                onPress={() => goToHit(threadHits, threadHitIdx + 1, threadQuery.trim())}
                style={({ pressed }) => [s.hitBtn, pressed && s.pressed60]}
              >
                <PounceIcon
                  name="chevron-down"
                  size={17}
                  color={threadHits.length ? theme.colors.fgMuted : theme.colors.fgFaint}
                />
              </Pressable>
            </View>
          ) : null}
        </View>

        <View style={s.transcriptArea}>
          {/* One readable column for every transcript-area state. Desktop:
            proportional (92% of the pane, capped) so the chat adapts to the
            window; mobile: full width, unchanged. */}
          <View style={[s.flex1, DESKTOP ? { width: "92%", maxWidth: 900 } : { width: "100%" }]}>
            {loading && events.length === 0 ? (
              <TimelineSkeleton />
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
                <Timeline
                  events={rawEvents}
                  tasks={tasks}
                  agent={session.agent}
                  cwd={session.cwd}
                  sessionId={id!}
                  listRef={listRef}
                  highlight={searchHighlight}
                  anchorToId={anchorId}
                  onLongPressEvent={onLongPressEvent}
                  onRunCommand={canSteer ? onRunCommand : undefined}
                  onAtBottomChange={setAtBottom}
                  onRespondPermission={(requestId, optionId) => {
                    if (session?.hostId)
                      void respondPermission(session.hostId, requestId, optionId);
                  }}
                  onRespondPrompt={(_promptId, optionIndex) => {
                    if (session?.hostId && id) void respondPrompt(session.hostId, id, optionIndex);
                  }}
                  onSendInput={(data) => {
                    if (session?.hostId && id) void sendSessionInput(session.hostId, id, data);
                  }}
                  footer={
                    running ? (
                      <WorkingIndicator
                        agent={session.agent}
                        since={turnStartTs}
                        tokens={turnTokens}
                      />
                    ) : undefined
                  }
                />
                {/* Floating "jump to latest" — appears when scrolled up off the bottom. */}
                {!atBottom ? (
                  <Animated.View
                    entering={FadeIn.duration(150)}
                    exiting={FadeOut.duration(120)}
                    pointerEvents="box-none"
                    style={ANIM.jumpWrap}
                  >
                    <Pressable
                      onPress={() => {
                        // Tapping = give up the send anchor: the spacer drops and
                        // pin-to-tail resumes for the rest of the turn.
                        setAnchorId(null);
                        listRef.current?.scrollToEnd({ animated: true });
                        setAtBottom(true);
                      }}
                      style={({ pressed }) => [s.jumpPill, pressed && s.pressed80]}
                    >
                      <PounceIcon name="arrow-down" size={15} color={theme.colors.accent} />
                      <Text style={s.jumpLabel}>Latest</Text>
                    </Pressable>
                  </Animated.View>
                ) : null}
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
          onViewContext={
            session.cwd
              ? () =>
                  router.push({
                    pathname: "/context",
                    params: { cwd: session.cwd!, hostId: session.hostId, repoId: session.repoId },
                  })
              : undefined
          }
          onAddSource={canSteer ? () => composerRef.current?.startMention() : undefined}
          onRemoveSource={(p) => removeSource(session.id, p)}
          onFixConflicts={
            canSteer
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
          effort={canSteer && showEffort ? { label: effortLabel, onPress: openEffort } : null}
          mode={canSteer && showMode ? { label: modeLabel, onPress: openMode } : null}
          onClose={() => setModelSheet(false)}
        />

        {/* Composer (model·effort, mode, mic and send now live inside its card) —
          same adaptive column as the transcript so they stay aligned. */}
        <View style={[s.composerBar, { paddingBottom: insets.bottom + 8 }]}>
          <View style={DESKTOP ? { width: "92%", maxWidth: 900 } : { width: "100%" }}>
            {!canSteer ? (
              <Text style={s.archivedNote}>
                Archived session — worktree was removed. Read-only.
              </Text>
            ) : null}
            {/* Live task progress. Shown for the whole turn, and afterwards only
              while work remains — a finished checklist stays in the transcript
              rather than lingering above the composer. */}
            {taskState && (running || taskState.items.some((i) => i.status !== "completed")) ? (
              <TaskProgressBar state={taskState} running={running} />
            ) : null}
            {queued.length > 0 ? (
              <View style={s.queuedWrap}>
                {queued.map((q, i) => (
                  <View key={i} style={s.queuedRow}>
                    <PounceIcon name="time-outline" size={13} color={theme.colors.fgFaint} />
                    <Text numberOfLines={1} style={s.queuedText}>
                      {q.text || (q.images.length ? "🖼️ Image" : "")}
                    </Text>
                    <Pressable onPress={() => cancelQueued(i)} hitSlop={8}>
                      <PounceIcon name="close" size={14} color={theme.colors.fgMuted} />
                    </Pressable>
                  </View>
                ))}
                <Text style={s.queuedHint}>Queued — sends after the current reply</Text>
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
              onViewChanges={() => router.push(`/changes?id=${session.id}`)}
              diffStat={diffStat}
              model={
                live && !!session.cwd
                  ? { label: modelPillLabel, onPress: () => setModelSheet(true) }
                  : null
              }
              // Mode lives in the Model sheet now; the pill only appears as a
              // fallback when there's no model pill to reach that sheet through.
              mode={
                canSteer && showMode && !(live && !!session.cwd)
                  ? { label: modeLabel, active: activeMode !== "default", onPress: openMode }
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
      </DropZone>
    </KeyboardAvoidingView>
  );
}

/** Plain styles for Reanimated views — unistyles sheet entries carry the C++
 *  proxy, which Animated.View rejects ("an empty object is not a valid style
 *  value"). Layout-only, so nothing here needs theme reactivity. */
const ANIM = {
  flex1: { flex: 1 },
  jumpWrap: { position: "absolute", bottom: 12, left: 0, right: 0, alignItems: "center" },
} as const;

const s = StyleSheet.create((theme) => ({
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
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingBottom: 10,
    paddingTop: 4,
  },
  iconBtn: { height: 36, width: 36, alignItems: "center", justifyContent: "center" },
  backGlyph: { fontSize: 22, color: theme.colors.fg },
  headerTitle: { fontSize: 15, fontWeight: "600", color: theme.colors.fg },
  headerSubRow: { marginTop: 2, flexDirection: "row", alignItems: "center", gap: 8 },
  activityLabel: { fontSize: 12, color: theme.colors.fgMuted },
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
  // Transparent, borderless bar — the Composer's floating glass pill carries
  // its own margins and chrome now.
  composerBar: { alignItems: "center", paddingTop: 8 },
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
