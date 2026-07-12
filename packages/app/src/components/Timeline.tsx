import { memo, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { LegendList, type LegendListRef } from "@legendapp/list/react-native";
import { Ionicons } from "@expo/vector-icons";
import {
  assertNeverEvent,
  type TimelineEvent,
  type ToolCallEvent,
  type ToolResultEvent,
} from "@litter/shared";
import { defaultMarked } from "../state/stores";
import { useThreadMarkers } from "../state/db/hooks";
import { cn, COLOR } from "../ui";
import { MessageMarkdown } from "../components/MessageMarkdown";
import {
  cleanAssistantText,
  isEmptyUserMessage,
  parseUserMessage,
} from "@litter/transcript";

function toolCallIds(events: TimelineEvent[]): Set<string> {
  const s = new Set<string>();
  for (const e of events) if (e.type === "tool_call") s.add(e.call.id || e.id);
  return s;
}

/**
 * Drop tool_result rows whose call renders them inline as an accordion.
 * The session screen runs its marker indices through this same function so
 * marker jumps stay aligned with the list Timeline actually renders.
 */
export function collapseToolResults(events: TimelineEvent[]): TimelineEvent[] {
  const calls = toolCallIds(events);
  return events.filter(
    (e) => !(e.type === "tool_result" && calls.has(e.result.toolCallId || e.id.replace(/:o$/, ""))),
  );
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
    if (data[i].type !== "tool_call") { i++; continue; }
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
  footer,
  sessionId,
  listRef,
  onLongPressEvent,
  onRunCommand,
  onAtBottomChange,
}: {
  events: TimelineEvent[];
  /** Which agent produced these events — selects the body-cleaning rules. */
  agent?: string;
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
  // Subscribe to this thread's marker overrides once; each row gets its resolved
  // marked state as a prop (a per-row live query would be far too heavy).
  const markerMap = useThreadMarkers(sessionId);

  return (
    <LegendList
      ref={listRef}
      data={data}
      keyExtractor={(e) => e.id}
      renderItem={({ item }) => (
        <Row
          event={item}
          agent={agent}
          marked={markerMap.get(item.id) ?? defaultMarked(item, agent)}
          onLongPressEvent={onLongPressEvent}
          onRunCommand={onRunCommand}
          pairedResult={
            item.type === "tool_call" ? resultByCallId.get(item.call.id || item.id) : undefined
          }
          batchHeader={headers.get(item.id)}
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
      maintainScrollAtEnd
      onScroll={(e) => {
        const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
        const fromEnd = contentSize.height - (contentOffset.y + layoutMeasurement.height);
        onAtBottomChange?.(fromEnd < 80);
      }}
      scrollEventThrottle={64}
      ListFooterComponent={footer}
      contentContainerStyle={{ padding: 12, gap: 8 }}
    />
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
}) {
  const onLongPress = onLongPressEvent ? () => onLongPressEvent(event) : undefined;
  switch (event.type) {
    case "user_message":
      return (
        <Pressable onLongPress={onLongPress} delayLongPress={350}>
          <UserRow text={event.text} agent={agent} />
        </Pressable>
      );
    case "assistant_message":
      return (
        <Pressable onLongPress={onLongPress} delayLongPress={350}>
          <AssistantBubble
            text={event.text}
            agent={agent}
            streaming={event.streaming}
            marked={marked}
            onRun={onRunCommand}
          />
        </Pressable>
      );
    case "thinking_started":
      return <Meta text="Thinking…" />;
    case "thinking_finished":
      return <Meta text={event.text ? `💭 ${event.text}` : "Thought"} />;
    case "tool_call":
      if (!batchHeader) return <ToolAccordion event={event} result={pairedResult} />;
      return (
        <View className="gap-2">
          <Text className="pl-1 text-[12px] text-fg-muted">{batchHeader}</Text>
          <ToolAccordion event={event} result={pairedResult} />
        </View>
      );
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
  return <Bubble role="assistant" text={clean} streaming={streaming} marked={marked} onRun={onRun} />;
}

function UserRow({ text, agent }: { text: string; agent?: string }) {
  const p = useMemo(() => parseUserMessage(text, agent), [text, agent]);
  if (isEmptyUserMessage(p)) return null;
  return (
    <View className="gap-1.5">
      {p.command ? <CommandChip name={p.command.name} args={p.command.args} /> : null}
      {p.output ? <OutputNote text={p.output.text} isError={p.output.isError} /> : null}
      {p.text ? <Bubble role="user" text={p.text} /> : null}
    </View>
  );
}

/** A slash command the user ran, as a compact right-aligned pill. */
function CommandChip({ name, args }: { name: string; args?: string }) {
  return (
    <View className="flex-row justify-end">
      <View className="max-w-[86%] flex-row items-center gap-1.5 rounded-full border border-accent/40 bg-accent/15 px-3 py-1.5">
        <Text className="font-mono text-[13px] font-semibold text-accent">{name}</Text>
        {args ? (
          // flexShrink so long args truncate INSIDE the pill instead of pushing
          // the row past its max-width (text was bleeding out of the bubble).
          <Text numberOfLines={1} style={{ flexShrink: 1 }} className="font-mono text-[12px] text-fg-muted">
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
    <View className="flex-row justify-end">
      <View
        className={cn(
          "max-w-[86%] rounded-xl border px-3 py-1.5",
          isError ? "border-danger/40 bg-danger/10" : "border-border bg-surface-alt",
        )}
      >
        <Text
          numberOfLines={6}
          className={cn("font-mono text-[12px]", isError ? "text-danger" : "text-fg-muted")}
        >
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
  // User turns are compact right-aligned accent bubbles; assistant turns render
  // full-width (rich markdown/code needs the room), no bubble chrome. Both go
  // through the native md4c renderer — the user composes markdown too.
  if (role === "user") {
    return (
      <View className="flex-row justify-end">
        <View className="max-w-[86%] rounded-2xl bg-accent px-3 py-1.5">
          <MessageMarkdown text={text} role="user" streaming={streaming} />
        </View>
      </View>
    );
  }
  return (
    <View className="flex-row items-start gap-1">
      <View className="flex-1">
        <MessageMarkdown text={text} role="assistant" streaming={streaming} onRun={onRun} />
      </View>
      {marked ? <Ionicons name="bookmark" size={10} color={COLOR.accent} style={{ marginTop: 3 }} /> : null}
    </View>
  );
}

function previewInput(input: unknown): string {
  if (!input) return "";
  if (typeof input === "object") {
    const o = input as Record<string, unknown>;
    if (typeof o.command === "string") return o.command;
    if (typeof o.file_path === "string") return o.file_path;
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
function ToolAccordion({ event, result }: { event: ToolCallEvent; result?: ToolResultEvent }) {
  // Rows are recycled: key the expansion to the event id so an open accordion
  // can't bleed into whatever event this component instance shows next.
  const [openId, setOpenId] = useState<string | null>(null);
  const open = openId === event.id;
  const { name, status, input } = event.call;
  const shell = SHELL_TOOLS.has(name.toLowerCase());
  const preview = previewInput(input);
  const failed = status === "error" || result?.result.isError === true;
  const running = status === "pending" || status === "running";
  const expandable = !!result || preview.includes("\n");
  return (
    <Pressable
      disabled={!expandable}
      onPress={() => setOpenId(open ? null : event.id)}
      className={cn(
        "rounded-xl border px-3 py-2",
        failed ? "border-danger/40 bg-danger/10" : "border-border bg-surface-alt",
      )}
    >
      <View className="flex-row items-center gap-2">
        {shell ? (
          <Text style={{ color: failed ? COLOR.danger : SHELL_GOLD }} className="font-mono text-[13px] font-semibold">
            $
          </Text>
        ) : (
          <Text className="font-mono text-[12px] text-fg">⚙ {name}</Text>
        )}
        <Text
          numberOfLines={open ? undefined : 1}
          className="flex-1 font-mono text-[12px] leading-[17px] text-fg-muted"
        >
          {open ? preview : preview.replace(/\s+/g, " ")}
        </Text>
        {running ? (
          <Text className="text-[11px] text-fg-muted">…</Text>
        ) : expandable ? (
          <Ionicons name={open ? "chevron-up" : "chevron-down"} size={13} color={COLOR.fgFaint} />
        ) : null}
      </View>
      {open && result ? (
        <View className="mt-2">
          <ResultBody content={result.result.content} isError={result.result.isError} nested />
        </View>
      ) : null}
    </Pressable>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ResultBody({ content, isError, nested }: { content: any; isError: boolean; nested?: boolean }) {
  if (content?.kind === "diff") {
    return (
      <View className={cn("overflow-hidden rounded-xl border border-border bg-[#0d0d12]", nested && "rounded-lg")}>
        <Text className="border-b border-border px-3 py-1 font-mono text-[11px] text-fg-muted">{content.path || "diff"}</Text>
        <Text numberOfLines={nested ? 30 : 14} className="px-3 py-2 font-mono text-[11px] text-fg-muted">{content.patch}</Text>
      </View>
    );
  }
  const text = content?.kind === "text" ? content.text : content?.kind === "json" ? JSON.stringify(content.value) : "";
  if (!text) return null;
  return (
    <View
      className={cn(
        "rounded-xl bg-[#0d0d12] px-3 py-2",
        nested && "rounded-lg border border-border",
        isError && "border border-danger/40",
      )}
    >
      <Text numberOfLines={nested ? 30 : 12} className="font-mono text-[12px] text-[#cdd0d6]">
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
    <View className="rounded-xl bg-black p-2">
      <Text numberOfLines={20} className={cn("font-mono text-[12px]", stream === "stderr" ? "text-danger" : "text-[#d6d6d6]")}>
        {data}
      </Text>
    </View>
  );
}

function Meta({ text, level }: { text: string; level?: "info" | "warning" | "error" }) {
  return (
    <Text className={cn("py-0.5 text-center text-[11px]", level === "error" ? "text-danger" : "text-fg-faint")}>
      {text}
    </Text>
  );
}
