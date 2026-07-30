import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Image, Pressable, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { LegendList, type LegendListRef } from "@legendapp/list/react-native";
import { PounceIcon } from "../ui/native/Icon";
import { VideoPlayer } from "../ui/native/VideoPlayer";
import {
  assertNeverEvent,
  type MessageImage,
  type PermissionRequestEvent,
  type PromptRequestEvent,
  type TimelineEvent,
  type ToolCallEvent,
  type ToolResultEvent,
} from "@pounce/shared";
import { defaultMarked } from "../state/stores";
import { useThreadMarkers } from "../state/db/hooks";
import { MessageMarkdown } from "../components/MessageMarkdown";
import { PromptForm } from "../components/PromptForm";
import { DiffBlock, HlText } from "../components/CodeHighlight";
import { Modal } from "../components/AppModal";
import { cleanAssistantText, isEmptyUserMessage, parseUserMessage } from "@pounce/transcript";
// collapseToolResults lives in a pure (RN-free) module so it can be unit-tested;
// imported for use below and re-exported since Session.tsx imports it from here.
import { collapseToolResults } from "./timelineEvents";
import { deriveTaskTimeline, isTaskCall, type TaskItem } from "./taskEvents";
import { TodoCard } from "./TodoCard";

export { collapseToolResults };

/** Claude Code / Codex write an interruption as a user-role text marker. */
function isInterrupt(text: string): boolean {
  return /^\s*\[Request interrupted by user/i.test(text);
}

/** One human phrase for `n` calls of one tool, Claude Code's TUI wording. */
function batchPhrase(name: string, n: number): string {
  const s = n === 1 ? "" : "s";
  switch (name) {
    case "Grep":
    case "Glob":
      return `searching for ${n} pattern${s}`;
    case "Read":
      return `reading ${n} file${s}`;
    case "LS":
      return `listing ${n} director${n === 1 ? "y" : "ies"}`;
    case "shell":
    case "Bash":
      return `running ${n} shell command${s}`;
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit":
      return `editing ${n} file${s}`;
    case "WebFetch":
      return `fetching ${n} page${s}`;
    case "WebSearch":
      return `running ${n} web search${n === 1 ? "" : "es"}`;
    case "Task":
    case "Agent":
      return `launching ${n} agent${s}`;
    default:
      return n === 1 ? `calling ${name}` : `calling ${name} ×${n}`;
  }
}

/**
 * Claude Code prefixes a parallel tool batch with a synthesized summary line
 * ("Searching for 2 patterns, reading 1 file, …") — that line is TUI-generated,
 * never in the transcript, so mirror it here: map the FIRST tool_call of every
 * run of ≥2 consecutive calls to its summary.
 */
function batchHeaders(data: TimelineEvent[]): Map<string, string> {
  const m = new Map<string, string>();
  let i = 0;
  while (i < data.length) {
    if (data[i].type !== "tool_call") {
      i++;
      continue;
    }
    let j = i;
    while (j < data.length && data[j].type === "tool_call") j++;
    if (j - i >= 2) {
      const counts = new Map<string, number>();
      for (let k = i; k < j; k++) {
        const name = (data[k] as ToolCallEvent).call.name;
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
      const text = [...counts.entries()].map(([name, n]) => batchPhrase(name, n)).join(", ") + "…";
      m.set(data[i].id, text.charAt(0).toUpperCase() + text.slice(1));
    }
    i = j;
  }
  return m;
}

/** One virtualized timeline for a session — every event type, recycled rows. */
export const Timeline = memo(function Timeline({
  events,
  agent,
  cwd,
  footer,
  sessionId,
  listRef,
  onLongPressEvent,
  onRunCommand,
  onAtBottomChange,
  onRespondPermission,
  onRespondPrompt,
  onSendInput,
  highlight,
  anchorToId,
}: {
  events: TimelineEvent[];
  /** Which agent produced these events — selects the body-cleaning rules. */
  agent?: string;
  /** The thread's working dir (worktree) — tool-call paths render relative to it. */
  cwd?: string | null;
  /** Answer an ACP permission prompt (requestId, chosen optionId or null). */
  onRespondPermission?: (requestId: string, optionId: string | null) => void;
  /** Answer an interactive prompt by option index (trust/permission/plan/question). */
  onRespondPrompt?: (promptId: string, optionIndex: number) => void;
  /** Send raw input to the hosted CLI (free-form replies, Esc) — prompt escape hatch. */
  onSendInput?: (data: string) => void;
  footer?: React.ReactElement;
  /** Marker state is scoped per session — required for marked indicators. */
  sessionId?: string;
  /** Imperative list handle (scrollToIndex for marker jumps). */
  listRef?: React.Ref<LegendListRef>;
  onLongPressEvent?: (ev: TimelineEvent) => void;
  /** Queue a shell command into the composer (Run buttons on shell code blocks).
   *  Absent for read-only threads. */
  onRunCommand?: (command: string) => void;
  /** Fires as the user scrolls, telling the parent whether the list is pinned to
   *  the bottom — drives the floating "jump to latest" pill. */
  onAtBottomChange?: (atBottom: boolean) => void;
  /** Search deep-link: mark this event's row so the user sees WHY they landed
   *  here — yellow accent + the matched term. */
  highlight?: { id: string; term: string };
  /** The just-sent user message's id. Triggers ONE scroll to the end so the
   *  turn starts pinned there; from that point `maintainScrollAtEnd` follows
   *  the streaming reply natively (LegendList's chat pattern) and a user
   *  scroll-up detaches it. Cleared by the parent when the turn completes. */
  anchorToId?: string | null;
}) {
  // Pair each tool result with its call so the call row renders both as one
  // accordion; the paired result rows are dropped from the list data.
  const resultByCallId = useMemo(() => {
    const m = new Map<string, ToolResultEvent>();
    for (const e of events) {
      if (e.type === "tool_result") m.set(e.result.toolCallId || e.id.replace(/:o$/, ""), e);
    }
    return m;
  }, [events]);
  const data = useMemo(() => collapseToolResults(events), [events]);
  const headers = useMemo(() => batchHeaders(data), [data]);
  // Task events accumulate fast (a create/update per tick). Fold them once here:
  // the newest one renders the full checklist, the superseded ones become a
  // one-line trace of how the plan evolved.
  //
  // Folded over `events`, NOT `data`: TaskCreate's assigned id lives in its
  // tool RESULT, and `data` has already collapsed those results into their
  // calls. Folding the collapsed list would silently fall back to positional
  // numbering and could map updates onto the wrong task in a resumed thread —
  // and would disagree with the pinned widget, which folds the raw list.
  const tasks = useMemo(() => deriveTaskTimeline(events), [events]);
  // Subscribe to this thread's marker overrides once; each row gets its resolved
  // marked state as a prop (a per-row live query would be far too heavy).
  const markerMap = useThreadMarkers(sessionId);

  // --- Send scroll ----------------------------------------------------------
  // Timeline needs its own imperative handle for the send scroll, but the
  // parent also holds one (marker jumps / the Latest pill) — feed both.
  const innerRef = useRef<LegendListRef | null>(null);
  const setRefs = useCallback(
    (r: LegendListRef | null) => {
      innerRef.current = r;
      if (typeof listRef === "function") listRef(r);
      else if (listRef) (listRef as { current: LegendListRef | null }).current = r;
    },
    [listRef],
  );
  // One-shot per send: land at the end even if the user was reading history.
  // From there LegendList's own chat behavior (maintainScrollAtEnd + threshold)
  // follows the streaming reply automatically and detaches when the user
  // scrolls up — no manual tail-following.
  const consumedAnchor = useRef<string | null>(null);
  useEffect(() => {
    if (!anchorToId || consumedAnchor.current === anchorToId) return;
    consumedAnchor.current = anchorToId;
    requestAnimationFrame(() => {
      // Not animated: while an animated scroll is in flight the first reply
      // chunks land, the pin's near-end check samples mid-animation, and
      // following never engages — an atomic jump closes that race.
      innerRef.current?.scrollToEnd({ animated: false });
      onAtBottomChange?.(true);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchorToId]);

  return (
    <View style={s.flex1}>
      <LegendList
        ref={setRefs}
        data={data}
        keyExtractor={(e) => e.id}
        renderItem={({ item }) => (
          <Row
            event={item}
            agent={agent}
            marked={markerMap.get(item.id) ?? defaultMarked(item, agent)}
            onLongPressEvent={onLongPressEvent}
            onRunCommand={onRunCommand}
            cwd={cwd}
            pairedResult={
              item.type === "tool_call" ? resultByCallId.get(item.call.id || item.id) : undefined
            }
            batchHeader={headers.get(item.id)}
            taskList={item.id === tasks.latestEventId ? tasks.state?.items : undefined}
            taskLabel={tasks.labels.get(item.id)}
            onRespondPermission={onRespondPermission}
            onRespondPrompt={onRespondPrompt}
            onSendInput={onSendInput}
            highlightTerm={highlight && item.id === highlight.id ? highlight.term : undefined}
          />
        )}
        // A blended average across the row types (short user bubbles / meta lines
        // vs. taller assistant turns) — closer to reality than 72, so scrolling
        // through unmeasured history settles with less correction.
        estimatedItemSize={96}
        recycleItems
        // Bottom-anchored streaming chat, Claude-style. Two independent behaviours,
        // and conflating them was the "random jump" bug:
        //   • size: true  — keep visible content steady when an item *resizes*
        //     (the last bubble growing token-by-token, or an accordion above
        //     expanding). New turns only ever append BELOW the viewport, so a
        //     scrolled-up reading position stays put without data-anchoring.
        //   • data: false — do NOT re-anchor to a visible item on every data
        //     update. Streaming fires one data update per token; with the bare
        //     `maintainVisibleContentPosition` (which normalizes to
        //     { data: true, size: true }) each token re-anchored some visible row
        //     and fought maintainScrollAtEnd's pin-to-tail — the jitter the user
        //     saw. Tail-following is maintainScrollAtEnd's job alone.
        maintainVisibleContentPosition={{ data: false, size: true }}
        alignItemsAtEnd
        // Open on the newest message (bottom), not the top of the history, and
        // stay pinned to the end as live turns stream in (dataChange + itemLayout
        // triggers follow the growing last bubble); only while near the end so a
        // scrolled-up user isn't yanked down.
        initialScrollAtEnd
        // The chat pattern from LegendList's own guide: stay pinned to the end
        // as the streaming reply grows (data + item-layout triggers), but only
        // while the viewport is within the threshold of the bottom — scrolling
        // up detaches automatically, riding back down re-attaches.
        maintainScrollAtEnd
        // 0.25 viewport: forgiving enough that a chunky growth step (a pasted
        // paragraph, the settled-row swap at turn end) doesn't spuriously
        // detach the pin, while a deliberate scroll-up still does.
        maintainScrollAtEndThreshold={0.25}
        onScroll={(e) => {
          const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
          const fromEnd = contentSize.height - (contentOffset.y + layoutMeasurement.height);
          onAtBottomChange?.(fromEnd < 80);
        }}
        scrollEventThrottle={64}
        ListFooterComponent={footer}
        contentContainerStyle={{ padding: 12, gap: 8 }}
      />
    </View>
  );
});

const Row = memo(function Row({
  event,
  agent,
  marked,
  onLongPressEvent,
  onRunCommand,
  pairedResult,
  batchHeader,
  taskList,
  taskLabel,
  cwd,
  onRespondPermission,
  onRespondPrompt,
  onSendInput,
  highlightTerm,
}: {
  event: TimelineEvent;
  agent?: string;
  /** Resolved marker state (override ▸ default), computed by the Timeline root. */
  marked: boolean;
  onLongPressEvent?: (ev: TimelineEvent) => void;
  onRunCommand?: (command: string) => void;
  /** For tool_call rows: the matching tool_result, rendered inside the accordion. */
  pairedResult?: ToolResultEvent;
  /** For the first call of a parallel batch: the synthesized summary line. */
  batchHeader?: string;
  /** Set on the newest task event: the folded checklist to render as a card. */
  taskList?: readonly TaskItem[];
  /** Set on superseded task events: their one-line trace label. */
  taskLabel?: string;
  /** Thread cwd — tool-call file paths render relative to it. */
  cwd?: string | null;
  /** Answer an ACP permission prompt (requestId, chosen optionId or null). */
  onRespondPermission?: (requestId: string, optionId: string | null) => void;
  /** Answer an interactive prompt by option index (trust/permission/plan/question). */
  onRespondPrompt?: (promptId: string, optionIndex: number) => void;
  /** Send raw input to the hosted CLI (free-form replies, Esc). */
  onSendInput?: (data: string) => void;
  /** Set on the search deep-link target row — yellow accent + matched term. */
  highlightTerm?: string;
}) {
  const onLongPress = onLongPressEvent ? () => onLongPressEvent(event) : undefined;
  switch (event.type) {
    case "user_message":
      // An interruption isn't a message — Claude Code records it as user text
      // but shows it as a system note. Mirror that instead of a prose bubble.
      if (isInterrupt(event.text)) return <Meta text="⎿ Interrupted by user" level="warning" />;
      return (
        <Pressable onLongPress={onLongPress} delayLongPress={350}>
          <SearchHighlight term={highlightTerm}>
            <UserRow text={event.text} agent={agent} images={event.images} />
          </SearchHighlight>
        </Pressable>
      );
    case "assistant_message":
      return (
        <Pressable onLongPress={onLongPress} delayLongPress={350}>
          <SearchHighlight term={highlightTerm}>
            <AssistantBubble
              text={event.text}
              agent={agent}
              streaming={event.streaming}
              marked={marked}
              onRun={onRunCommand}
            />
          </SearchHighlight>
        </Pressable>
      );
    case "thinking_started":
      return <Meta text="Thinking…" />;
    case "thinking_finished":
      return <Meta text={event.text ? `💭 ${event.text}` : "Thought"} />;
    case "tool_call": {
      // Entering plan mode is a state change, not a tool worth a card — show the
      // same quiet banner Claude Code does.
      if (event.call.name === "EnterPlanMode")
        return <Meta text="⏸ Entered plan mode — exploring, no changes yet" level="info" />;
      // Plan mode: ExitPlanMode carries the proposed plan as markdown — render
      // it as a first-class plan card, not a muted one-line tool row.
      const plan =
        event.call.name === "ExitPlanMode"
          ? (event.call.input as { plan?: unknown } | undefined)?.plan
          : undefined;
      if (typeof plan === "string" && plan.trim()) return <PlanCard plan={plan} />;
      // The agent's own checklist. The plan IS the content here, so the newest
      // task event renders it as a card and the superseded ones stay a quiet
      // one-line trace — a dozen repeated checklists would bury the turn.
      if (isTaskCall(event)) {
        if (taskList?.length) return <TodoCard items={taskList} latest />;
        if (taskLabel) return <Meta text={taskLabel} />;
        return <Meta text="Task list cleared" />;
      }
      if (!batchHeader)
        return (
          <SearchHighlight term={highlightTerm}>
            <ToolAccordion event={event} result={pairedResult} cwd={cwd} />
          </SearchHighlight>
        );
      return (
        <View style={s.gap8}>
          <Text style={s.batchHeader}>{batchHeader}</Text>
          <SearchHighlight term={highlightTerm}>
            <ToolAccordion event={event} result={pairedResult} cwd={cwd} />
          </SearchHighlight>
        </View>
      );
    }
    case "tool_result":
      return <ToolResult content={event.result.content} isError={event.result.isError} />;
    case "task_created":
    case "task_started":
    case "task_progress":
    case "task_completed":
    case "task_failed":
      return <Meta text={`Task ${event.state}`} />;
    case "git_event":
      return <Meta text={`git: ${event.summary}`} />;
    case "terminal_event":
      return <Term data={event.data} stream={event.stream} />;
    case "system_event":
      return <Meta text={event.message} level={event.level} />;
    case "permission_request":
      return <PermissionCard event={event} onRespond={onRespondPermission} />;
    case "prompt_request":
      return <PromptCard event={event} onRespond={onRespondPrompt} onSendInput={onSendInput} />;
    default:
      return assertNeverEvent(event);
  }
});

/**
 * A user turn — but the raw text may be a slash-command envelope, captured
 * command output, or pure transcript noise rather than typed prose. Normalize
 * first, then render whichever pieces survive (command chip, output note, and/or
 * a prose bubble). Empty envelopes (lone caveats/reminders) render nothing.
 */
/** Assistant turn — memoizes the (regex-heavy) body cleaning so a row re-render
 *  (recycling / marker toggle) doesn't re-clean unchanged text. */
function AssistantBubble({
  text,
  agent,
  streaming,
  marked,
  onRun,
}: {
  text: string;
  agent?: string;
  streaming?: boolean;
  marked?: boolean;
  onRun?: (command: string) => void;
}) {
  const clean = useMemo(() => cleanAssistantText(text, agent), [text, agent]);
  return (
    <Bubble role="assistant" text={clean} streaming={streaming} marked={marked} onRun={onRun} />
  );
}

function UserRow({
  text,
  agent,
  images,
}: {
  text: string;
  agent?: string;
  images?: readonly MessageImage[];
}) {
  const p = useMemo(() => parseUserMessage(text, agent), [text, agent]);
  const hasImages = !!images?.length;
  // An image-only message (no prose) must still render, so don't bail on empty.
  if (isEmptyUserMessage(p) && !hasImages) return null;
  return (
    <View style={s.gap6}>
      {p.command ? <CommandChip name={p.command.name} args={p.command.args} /> : null}
      {p.output ? <OutputNote text={p.output.text} isError={p.output.isError} /> : null}
      {hasImages ? <InlineImages images={images!} /> : null}
      {p.text ? <Bubble role="user" text={p.text} /> : null}
    </View>
  );
}

/**
 * An ACP permission prompt: the agent is asking to run a tool. Renders the
 * options as buttons; tapping answers the paused turn on the host and locks the
 * card to the chosen outcome. Reject options render subdued, allow options
 * accented.
 */
function PermissionCard({
  event,
  onRespond,
}: {
  event: PermissionRequestEvent;
  onRespond?: (requestId: string, optionId: string | null) => void;
}) {
  const [chosen, setChosen] = useState<string | null>(null);
  const answered = chosen !== null;
  const pick = (optionId: string, label: string) => {
    if (answered) return;
    setChosen(label);
    onRespond?.(event.requestId, optionId);
  };
  return (
    <View style={s.permCard}>
      <View style={s.rowCenter6}>
        <PounceIcon name="shield-checkmark-outline" size={13} color="#d29922" />
        <Text style={s.permTitle}>{event.toolTitle}</Text>
      </View>
      {answered ? (
        <Text style={s.permChosen}>You chose: {chosen}</Text>
      ) : (
        <View style={s.optionsWrap}>
          {event.options.map((o) => {
            const reject = /reject|deny|no/i.test(o.kind || o.optionId || o.name);
            return (
              <Pressable
                key={o.optionId}
                onPress={() => pick(o.optionId, o.name)}
                style={({ pressed }) => [
                  s.optionBtn,
                  reject ? s.optionBtnReject : s.optionBtnAllow,
                  pressed && s.pressed80,
                ]}
              >
                <Text style={[s.optionLabel, reject ? s.optionLabelReject : s.optionLabelAllow]}>
                  {o.name}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}
    </View>
  );
}

/**
 * A generic interactive prompt — trust-folder, tool permission, plan approval,
 * AskUserQuestion, any on-screen menu. The bridge detects it from the terminal
 * screen (agent-agnostic), so this ONE card answers them all. The body is the
 * shared PromptForm (also presented as the auto-opening form sheet); this is
 * just its inline-timeline chrome. Mirrors PermissionCard.
 */
function PromptCard({
  event,
  onRespond,
  onSendInput,
}: {
  event: PromptRequestEvent;
  onRespond?: (promptId: string, optionIndex: number) => void;
  onSendInput?: (data: string) => void;
}) {
  return (
    <View style={s.accentCard}>
      <PromptForm prompt={event} onRespond={onRespond} onSendInput={onSendInput} />
    </View>
  );
}

/** Plan mode's proposed plan (from ExitPlanMode), rendered as markdown in a
 *  distinct accent card so it reads as a plan, not a buried tool call. */
function PlanCard({ plan }: { plan: string }) {
  const { theme } = useUnistyles();
  return (
    <View style={[s.accentCard, s.gap6]}>
      <View style={s.rowCenter6}>
        <PounceIcon name="map-outline" size={13} color={theme.colors.accent} />
        <Text style={s.planLabel}>Plan</Text>
      </View>
      <MessageMarkdown text={plan} role="assistant" />
    </View>
  );
}

const THUMB = 128;

/** Video attachments by mediaType, with an extension fallback for transcript
 *  events that only carry a path/uri. */
function isVideo(att: MessageImage): boolean {
  if (att.mediaType?.startsWith("video/")) return true;
  return /\.(mov|mp4|m4v|webm|avi|mkv)(\?|$)/i.test(att.uri ?? "");
}

/**
 * Attached media as right-aligned thumbnails; tap opens a full-size lightbox
 * (image viewer, or the native video player for video attachments).
 * Thumbnails render as soon as their row mounts — the list's virtualization
 * already bounds mounted rows, and the old useViewability gate never fired for
 * rows that mounted already-visible (perma-gray thumbnails).
 */
function InlineImages({ images, eager }: { images: readonly MessageImage[]; eager?: boolean }) {
  const [preview, setPreview] = useState<MessageImage | null>(null);
  const shown = images.filter((i) => i.uri);
  if (!shown.length) return null;
  return (
    <View style={[s.imagesRow, eager ? s.justifyStart : s.justifyEnd]}>
      {shown.map((att) =>
        isVideo(att) ? (
          <VideoTile key={att.uri} onPress={() => setPreview(att)} />
        ) : (
          <LazyImage key={att.uri} uri={att.uri!} onPress={() => setPreview(att)} />
        ),
      )}
      <Modal
        visible={!!preview}
        transparent
        animationType="fade"
        onRequestClose={() => setPreview(null)}
      >
        <Pressable
          onPress={() => setPreview(null)}
          style={[StyleSheet.absoluteFill, s.centerContent]}
        >
          <View style={[StyleSheet.absoluteFill, s.lightboxScrim]} />
          {preview && isVideo(preview) ? (
            <VideoPlayer uri={preview.uri!} style={s.lightboxMedia} />
          ) : preview ? (
            <Image source={{ uri: preview.uri! }} style={s.lightboxMedia} resizeMode="contain" />
          ) : null}
        </Pressable>
      </Modal>
    </View>
  );
}

/** A video attachment as a dark tile with a play glyph — no frame extraction
 *  (thumbnailing would need the player); the lightbox does the real playback. */
function VideoTile({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [s.thumb, s.videoTile, pressed && s.pressed80]}
    >
      <PounceIcon name="play" size={26} color="#fff" />
    </Pressable>
  );
}

/** One thumbnail whose network fetch is deferred until the row is viewable —
 *  unless `eager`, which renders immediately (viewability doesn't fire reliably
 *  for a thumbnail nested inside a tool card, so tool-card previews opt out). */
function LazyImage({ uri, onPress }: { uri: string; onPress: () => void }) {
  const { theme } = useUnistyles();
  // No viewability gating: the list's virtualization already bounds mounted
  // rows, and legend-list's useViewability doesn't reliably fire an initial
  // callback for rows that mount already-visible — thumbnails stayed gray
  // placeholders forever while the tap-through preview (ungated) worked.
  // Dead URIs (e.g. attachments whose app-container path no longer exists
  // after a reinstall) get an explicit broken state, not a silent gray box.
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <View style={[s.thumb, s.thumbPlaceholder, s.thumbBrokenWrap]}>
        <PounceIcon name="image-outline" size={22} color={theme.colors.fgFaint} />
        <Text style={s.thumbBrokenLabel}>Image unavailable</Text>
      </View>
    );
  }
  return (
    <Pressable onPress={onPress} style={({ pressed }) => pressed && s.pressed80}>
      <Image
        source={{ uri }}
        style={[s.thumb, s.thumbPlaceholder]}
        resizeMode="contain"
        onError={() => setFailed(true)}
      />
    </Pressable>
  );
}

/** A slash command the user ran, as a compact right-aligned pill. */
function CommandChip({ name, args }: { name: string; args?: string }) {
  return (
    <View style={s.rowEnd}>
      <View style={s.commandChip}>
        <Text style={s.commandName}>{name}</Text>
        {args ? (
          // flexShrink so long args truncate INSIDE the pill instead of pushing
          // the row past its max-width (text was bleeding out of the bubble).
          <Text numberOfLines={1} style={s.commandArgs}>
            {args}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

/** Captured stdout/stderr from a local command, collapsed to a subtle note. */
function OutputNote({ text, isError }: { text: string; isError: boolean }) {
  return (
    <View style={s.rowEnd}>
      <View style={[s.outputNote, isError ? s.outputNoteError : s.outputNoteOk]}>
        <Text numberOfLines={6} style={[s.monoText12, isError ? s.textDanger : s.textMuted]}>
          {text}
        </Text>
      </View>
    </View>
  );
}

function Bubble({
  role,
  text,
  streaming,
  marked,
  onRun,
}: {
  role: "user" | "assistant";
  text: string;
  streaming?: boolean;
  /** Shows a bookmark beside assistant bubbles the user marked. User bubbles
   *  are marked by default, so decorating them all would be noise. */
  marked?: boolean;
  /** Enables shell "Run" cards on assistant turns (queues !cmd to composer). */
  onRun?: (command: string) => void;
}) {
  const { theme } = useUnistyles();
  // User turns are compact right-aligned accent bubbles; assistant turns render
  // full-width (rich markdown/code needs the room), no bubble chrome. Both go
  // through the native md4c renderer — the user composes markdown too.
  if (role === "user") {
    return (
      <View style={s.rowEnd}>
        <View style={s.userBubble}>
          <MessageMarkdown text={text} role="user" streaming={streaming} />
        </View>
      </View>
    );
  }
  return (
    <View style={s.assistantRow}>
      <View style={s.flex1}>
        <MessageMarkdown text={text} role="assistant" streaming={streaming} onRun={onRun} />
      </View>
      {marked ? (
        <PounceIcon
          name="bookmark"
          size={10}
          color={theme.colors.accent}
          style={{ marginTop: 3 }}
        />
      ) : null}
    </View>
  );
}

/**
 * Show file paths relative to the thread's working directory (its worktree) —
 * `packages/app/src/Foo.tsx`, not `/Users/.../worktrees/…/packages/app/src/Foo.tsx`.
 * This is the convention every coding agent's UI uses. Paths outside the cwd
 * (rare) stay absolute so they're not misread as local.
 */
function relPath(p: string, cwd?: string | null): string {
  if (!cwd || !p.startsWith("/")) return p;
  const base = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return p.startsWith(base) ? p.slice(base.length) || p : p;
}

/** File-path-bearing tool inputs, per the common Claude Code / Codex tool set. */
const PATH_KEYS = ["file_path", "path", "notebook_path", "filePath"] as const;

function previewInput(input: unknown, cwd?: string | null): string {
  if (!input) return "";
  if (typeof input === "object") {
    const o = input as Record<string, unknown>;
    if (typeof o.command === "string") return o.command;
    for (const k of PATH_KEYS) if (typeof o[k] === "string") return relPath(o[k] as string, cwd);
    if (typeof o.query === "string") return o.query;
  }
  return typeof input === "string" ? input : "";
}

const SHELL_TOOLS = new Set(["shell", "bash", "exec", "terminal"]);
const SHELL_GOLD = "#d29922";

/**
 * One tool invocation as a collapsible card. Collapsed it is a single quiet
 * line — `$ command…` for shell, `⚙ name input…` otherwise — with a chevron.
 * Expanding reveals the full command and the tool's output nested in the same
 * card, instead of the output sprawling as its own full-width block.
 */
function ToolAccordion({
  event,
  result,
  cwd,
}: {
  event: ToolCallEvent;
  result?: ToolResultEvent;
  cwd?: string | null;
}) {
  const { theme } = useUnistyles();
  // Rows are recycled: key the expansion to the event id so an open accordion
  // can't bleed into whatever event this component instance shows next.
  const [openId, setOpenId] = useState<string | null>(null);
  const open = openId === event.id;
  const { name, status, input } = event.call;
  const shell = SHELL_TOOLS.has(name.toLowerCase());
  const preview = previewInput(input, cwd);
  const failed = status === "error" || result?.result.isError === true;
  const running = status === "pending" || status === "running";
  const expandable = !!result || preview.includes("\n") || !!event.call.previewUri;
  // Live terminal tail: while the command runs, agents that stream partial
  // output (codex today, claude via ACP later) keep updating the paired
  // result in place — show its last lines inside the collapsed card so the
  // user watches the command work instead of staring at a bare "Running".
  const tail = useMemo(() => {
    if (!running || open || result?.result.content?.kind !== "text") return null;
    const raw = String(result.result.content.text ?? "");
    // Strip ANSI escapes and carriage-return progress redraws before tailing.
    const clean = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/^.*\r(?!\n)/gm, "");
    const lines = clean
      .trimEnd()
      .split("\n")
      .filter((l) => l.trim().length > 0);
    return lines.length ? lines.slice(-3).join("\n") : null;
  }, [running, open, result]);
  return (
    <Pressable
      disabled={!expandable}
      onPress={() => setOpenId(open ? null : event.id)}
      style={[s.toolCard, failed ? s.toolCardFailed : s.toolCardOk]}
    >
      <View style={s.rowCenter8}>
        {shell ? (
          <Text style={[s.shellDollar, { color: failed ? theme.colors.danger : SHELL_GOLD }]}>
            $
          </Text>
        ) : (
          <Text style={s.toolName}>⚙ {name}</Text>
        )}
        {shell ? (
          // Highlight the command as bash — the collapsed row stays one line.
          <View style={s.flex1}>
            <HlText
              code={open ? preview : preview.replace(/\s+/g, " ")}
              language="bash"
              size={12}
              numberOfLines={open ? undefined : 1}
            />
          </View>
        ) : (
          <Text numberOfLines={open ? undefined : 1} style={s.toolPreview}>
            {open ? preview : preview.replace(/\s+/g, " ")}
          </Text>
        )}
        {running ? (
          <View style={s.rowCenter4}>
            <View style={s.runningDot} />
            <Text style={s.runningLabel}>Running</Text>
          </View>
        ) : expandable ? (
          <PounceIcon
            name={open ? "chevron-up" : "chevron-down"}
            size={13}
            color={theme.colors.fgFaint}
          />
        ) : null}
      </View>
      {open && event.call.previewUri ? (
        // A Read of an image → show the picture, not just the path, once the
        // card is expanded. Eager: a nested thumbnail's viewability doesn't
        // fire reliably inside a card.
        <View style={s.mt8}>
          <InlineImages images={[{ uri: event.call.previewUri, mediaType: "" }]} eager />
        </View>
      ) : null}
      {open && result ? (
        <View style={s.mt8}>
          <ResultBody content={result.result.content} isError={result.result.isError} nested />
        </View>
      ) : null}
      {tail ? (
        <View style={s.tailBox}>
          <Text numberOfLines={3} style={s.tailText}>
            {tail}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ResultBody({
  content,
  isError,
  nested,
}: {
  content: any;
  isError: boolean;
  nested?: boolean;
}) {
  if (content?.kind === "diff") {
    return (
      <DiffBlock
        patch={content.patch ?? ""}
        path={content.path}
        nested={nested}
        maxLines={nested ? 120 : 40}
      />
    );
  }
  const text =
    content?.kind === "text"
      ? content.text
      : content?.kind === "json"
        ? JSON.stringify(content.value)
        : "";
  if (!text) return null;
  return (
    <View style={[s.resultBox, nested && s.resultBoxNested, isError && s.resultBoxError]}>
      <Text numberOfLines={nested ? 30 : 12} style={s.resultText}>
        {text}
      </Text>
    </View>
  );
}

/** A tool result whose call isn't in the list — render standalone as before. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ToolResult({ content, isError }: { content: any; isError: boolean }) {
  return <ResultBody content={content} isError={isError} />;
}

function Term({ data, stream }: { data: string; stream: string }) {
  return (
    <View style={s.termBox}>
      <Text
        numberOfLines={20}
        style={[s.monoText12, stream === "stderr" ? s.textDanger : s.termTextOut]}
      >
        {data}
      </Text>
    </View>
  );
}

/** Background accent around the message a search deep-link landed on: soft
 *  tint, left bar, and a chip naming the matched term — so it's obvious why
 *  the thread opened scrolled to this spot. No-op without a term. */
const HIGHLIGHT = "#B3E561";
function SearchHighlight({ term, children }: { term?: string; children: React.ReactNode }) {
  if (!term) return <>{children}</>;
  return (
    <View
      style={{
        backgroundColor: "rgba(179, 229, 97, 0.16)",
        borderLeftColor: HIGHLIGHT,
        borderLeftWidth: 3,
        borderRadius: 10,
        paddingLeft: 6,
        paddingVertical: 4,
      }}
    >
      <Text style={{ color: HIGHLIGHT, fontSize: 11, fontWeight: "600", marginBottom: 2 }}>
        ⚲ matched “{term}”
      </Text>
      {children}
    </View>
  );
}

function Meta({ text, level }: { text: string; level?: "info" | "warning" | "error" }) {
  return <Text style={[s.meta, level === "error" ? s.textDanger : s.textFaint]}>{text}</Text>;
}

/* Soft accent/warning/danger tints (the old accent/40-style alpha classes) have
 * no PlatformColor equivalent, so they stay literal rgba of the palette hexes. */
const ACCENT_BORDER = "rgba(124, 111, 240, 0.4)";
const ACCENT_TINT = "rgba(124, 111, 240, 0.05)";
const WARNING_BORDER = "rgba(210, 153, 34, 0.4)";
const WARNING_TINT = "rgba(210, 153, 34, 0.1)";
const DANGER_BORDER = "rgba(248, 81, 73, 0.4)";
const DANGER_TINT = "rgba(248, 81, 73, 0.1)";
/* Terminal-style output blocks keep their fixed dark look in both schemes. */
const TERM_BG = "#0d0d12";
const TERM_FG = "#cdd0d6";

const s = StyleSheet.create((theme) => ({
  flex1: { flex: 1 },
  gap6: { gap: 6 },
  gap8: { gap: 8 },
  mt8: { marginTop: 8 },
  pressed80: { opacity: 0.8 },
  rowEnd: { flexDirection: "row", justifyContent: "flex-end" },
  rowCenter4: { flexDirection: "row", alignItems: "center", gap: 4 },
  rowCenter6: { flexDirection: "row", alignItems: "center", gap: 6 },
  rowCenter8: { flexDirection: "row", alignItems: "center", gap: 8 },
  centerContent: { alignItems: "center", justifyContent: "center" },
  textDanger: { color: theme.colors.danger },
  textMuted: { color: theme.colors.fgMuted },
  textFaint: { color: theme.colors.fgFaint },
  monoText12: { fontFamily: "JetBrainsMono", fontSize: 12 },
  batchHeader: { paddingLeft: 4, fontSize: 12, color: theme.colors.fgMuted },
  permCard: {
    gap: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: WARNING_BORDER,
    backgroundColor: WARNING_TINT,
    padding: 12,
  },
  permTitle: { flex: 1, fontSize: 13, fontWeight: "500", color: theme.colors.fg },
  permChosen: { fontSize: 12, fontWeight: "500", color: theme.colors.fgMuted },
  optionsWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  optionBtn: { borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
  optionBtnReject: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
  optionBtnAllow: { backgroundColor: theme.colors.accent },
  optionLabel: { fontSize: 13, fontWeight: "600" },
  optionLabelReject: { color: theme.colors.fgMuted },
  optionLabelAllow: { color: theme.colors.onAccent },
  accentCard: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: ACCENT_BORDER,
    backgroundColor: ACCENT_TINT,
    padding: 12,
  },
  planLabel: {
    fontSize: 12,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    color: theme.colors.accent,
  },
  imagesRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  justifyStart: { justifyContent: "flex-start" },
  justifyEnd: { justifyContent: "flex-end" },
  lightboxScrim: { backgroundColor: "rgba(0, 0, 0, 0.9)" },
  thumb: { width: THUMB, height: THUMB, borderRadius: 12 },
  thumbPlaceholder: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
  thumbBrokenWrap: { alignItems: "center", justifyContent: "center", gap: 4 },
  thumbBrokenLabel: { fontSize: 10, color: theme.colors.fgFaint },
  videoTile: { backgroundColor: "#000", alignItems: "center", justifyContent: "center" },
  lightboxMedia: { width: "94%", height: "84%" },
  commandChip: {
    maxWidth: "86%",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: ACCENT_BORDER,
    backgroundColor: theme.colors.accentSoft,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  commandName: {
    fontFamily: "JetBrainsMono",
    fontSize: 13,
    fontWeight: "600",
    color: theme.colors.accent,
  },
  commandArgs: {
    flexShrink: 1,
    fontFamily: "JetBrainsMono",
    fontSize: 12,
    color: theme.colors.fgMuted,
  },
  outputNote: {
    maxWidth: "86%",
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  outputNoteError: { borderColor: DANGER_BORDER, backgroundColor: DANGER_TINT },
  outputNoteOk: { borderColor: theme.colors.border, backgroundColor: theme.colors.surfaceAlt },
  userBubble: {
    maxWidth: "86%",
    borderRadius: 16,
    backgroundColor: theme.colors.accent,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  assistantRow: { flexDirection: "row", alignItems: "flex-start", gap: 4 },
  toolCard: { borderRadius: 12, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 8 },
  toolCardFailed: { borderColor: DANGER_BORDER, backgroundColor: DANGER_TINT },
  toolCardOk: { borderColor: theme.colors.border, backgroundColor: theme.colors.surfaceAlt },
  shellDollar: { fontFamily: "JetBrainsMono", fontSize: 13, fontWeight: "600" },
  toolName: { fontFamily: "JetBrainsMono", fontSize: 12, color: theme.colors.fg },
  toolPreview: {
    flex: 1,
    fontFamily: "JetBrainsMono",
    fontSize: 12,
    lineHeight: 17,
    color: theme.colors.fgMuted,
  },
  runningDot: { height: 6, width: 6, borderRadius: 999, backgroundColor: theme.colors.success },
  runningLabel: {
    fontSize: 10,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    color: theme.colors.success,
  },
  tailBox: {
    marginTop: 8,
    borderRadius: 8,
    backgroundColor: TERM_BG,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  tailText: {
    fontFamily: "JetBrainsMono",
    fontSize: 11,
    lineHeight: 15,
    color: theme.colors.fgFaint,
  },
  resultBox: {
    borderRadius: 12,
    backgroundColor: TERM_BG,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  resultBoxNested: { borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border },
  resultBoxError: { borderWidth: 1, borderColor: DANGER_BORDER },
  resultText: { fontFamily: "JetBrainsMono", fontSize: 12, color: TERM_FG },
  termBox: { borderRadius: 12, backgroundColor: "#000000", padding: 8 },
  termTextOut: { color: "#d6d6d6" },
  meta: { paddingVertical: 2, textAlign: "center", fontSize: 11 },
}));
