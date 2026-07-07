import { memo } from "react";
import { Pressable, Text, View } from "react-native";
import { LegendList, type LegendListRef } from "@legendapp/list/react-native";
import { useSelector } from "@legendapp/state/react";
import { Ionicons } from "@expo/vector-icons";
import { assertNeverEvent, type TimelineEvent } from "@litter/shared";
import { isMarked } from "@/state/stores";
import { cn, COLOR } from "@/ui";
import {
  cleanAssistantText,
  isEmptyUserMessage,
  parseUserMessage,
} from "@litter/transcript";

/** One virtualized timeline for a session — every event type, recycled rows. */
export const Timeline = memo(function Timeline({
  events,
  agent,
  footer,
  sessionId,
  listRef,
  onLongPressEvent,
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
}) {
  return (
    <LegendList
      ref={listRef}
      data={events}
      keyExtractor={(e) => e.id}
      renderItem={({ item }) => (
        <Row event={item} agent={agent} sessionId={sessionId} onLongPressEvent={onLongPressEvent} />
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
}: {
  event: TimelineEvent;
  agent?: string;
  sessionId?: string;
  onLongPressEvent?: (ev: TimelineEvent) => void;
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
          />
        </Pressable>
      );
    case "thinking_started":
      return <Meta text="Thinking…" />;
    case "thinking_finished":
      return <Meta text={event.text ? `💭 ${event.text}` : "Thought"} />;
    case "tool_call":
      return <ToolCard name={event.call.name} status={event.call.status} input={event.call.input} />;
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
}: {
  role: "user" | "assistant";
  text: string;
  streaming?: boolean;
  /** Shows a bookmark beside assistant bubbles the user marked. User bubbles
   *  are marked by default, so decorating them all would be noise. */
  marked?: boolean;
}) {
  const user = role === "user";
  return (
    <View className={cn("flex-row items-center gap-1.5", user ? "justify-end" : "justify-start")}>
      <View
        className={cn(
          "max-w-[86%] rounded-2xl px-3 py-2",
          user ? "bg-accent" : "border border-border bg-surface",
        )}
      >
        <Text className={cn("text-[15px] leading-[21px]", user ? "text-white" : "text-fg")}>
          {text}
          {streaming ? <Text className="text-accent"> ▋</Text> : null}
        </Text>
      </View>
      {marked && !user ? <Ionicons name="bookmark" size={10} color={COLOR.accent} /> : null}
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

function ToolCard({ name, status, input }: { name: string; status: string; input?: unknown }) {
  const ok = status === "success";
  return (
    <View className="rounded-xl bg-surface-alt px-3 py-2">
      <View className="flex-row items-center justify-between">
        <Text className="font-mono text-[13px] text-fg">⚙ {name}</Text>
        <Text className={cn("text-[11px]", ok ? "text-success" : status === "error" ? "text-danger" : "text-fg-muted")}>
          {status}
        </Text>
      </View>
      {previewInput(input) ? (
        <Text numberOfLines={2} className="mt-1 font-mono text-[11px] text-fg-muted">
          {previewInput(input)}
        </Text>
      ) : null}
    </View>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ToolResult({ content, isError }: { content: any; isError: boolean }) {
  if (content?.kind === "diff") {
    return (
      <View className="overflow-hidden rounded-xl border border-border bg-[#0d0d12]">
        <Text className="border-b border-border px-3 py-1 font-mono text-[11px] text-fg-muted">{content.path || "diff"}</Text>
        <Text numberOfLines={14} className="px-3 py-2 font-mono text-[11px] text-fg-muted">{content.patch}</Text>
      </View>
    );
  }
  const text = content?.kind === "text" ? content.text : content?.kind === "json" ? JSON.stringify(content.value) : "";
  if (!text) return null;
  return (
    <View className={cn("rounded-xl bg-[#0d0d12] px-3 py-2", isError && "border border-danger/40")}>
      <Text numberOfLines={12} className="font-mono text-[12px] text-[#cdd0d6]">{text}</Text>
    </View>
  );
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
