import { memo, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { LegendList, type LegendListRef } from "@legendapp/list/react-native";
import { useSelector } from "@legendapp/state/react";
import { Ionicons } from "@expo/vector-icons";
import {
  assertNeverEvent,
  type TimelineEvent,
  type ToolCallEvent,
  type ToolResultEvent,
} from "@litter/shared";
import { isMarked } from "@/state/stores";
import { cn, COLOR } from "@/ui";
import { MessageMarkdown } from "@/components/MessageMarkdown";
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

/** One virtualized timeline for a session — every event type, recycled rows. */
export const Timeline = memo(function Timeline({
  events,
  agent,
  footer,
  sessionId,
  listRef,
  onLongPressEvent,
  onRunCommand,
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

  return (
    <LegendList
      ref={listRef}
      data={data}
      keyExtractor={(e) => e.id}
      renderItem={({ item }) => (
        <Row
          event={item}
          agent={agent}
          sessionId={sessionId}
          onLongPressEvent={onLongPressEvent}
          onRunCommand={onRunCommand}
          pairedResult={
            item.type === "tool_call" ? resultByCallId.get(item.call.id || item.id) : undefined
          }
        />
      )}
      estimatedItemSize={72}
      recycleItems
      maintainVisibleContentPosition
      alignItemsAtEnd
      // Open on the newest message (bottom), not the top of the history, and
      // stay pinned to the end as live turns stream in.
      initialScrollAtEnd
      maintainScrollAtEnd
      ListFooterComponent={footer}
      contentContainerStyle={{ padding: 12, gap: 8 }}
    />
  );
});

const Row = memo(function Row({
  event,
  agent,
  sessionId,
  onLongPressEvent,
  onRunCommand,
  pairedResult,
}: {
  event: TimelineEvent;
  agent?: string;
  sessionId?: string;
  onLongPressEvent?: (ev: TimelineEvent) => void;
  onRunCommand?: (command: string) => void;
  /** For tool_call rows: the matching tool_result, rendered inside the accordion. */
  pairedResult?: ToolResultEvent;
}) {
  // Unconditional hook — recycled rows must keep a stable hook order.
  const marked = useSelector(() => (sessionId ? isMarked(sessionId, event) : false));
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
          <Bubble
            role="assistant"
            text={cleanAssistantText(event.text, agent)}
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
      return <ToolAccordion event={event} result={pairedResult} />;
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
function UserRow({ text, agent }: { text: string; agent?: string }) {
  const p = parseUserMessage(text, agent);
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
          <Text numberOfLines={1} className="font-mono text-[12px] text-fg-muted">
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
