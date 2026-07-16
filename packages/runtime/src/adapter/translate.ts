/**
 * translate — the ONLY place that knows the alleycat wire format.
 *
 * Maps a raw {@link WireEnvelope} to zero or more stable {@link TimelineEvent}s.
 * Rule: never throw on an unknown variant. Upstream adds payload `type`s often;
 * unknown ones degrade to a `system_event` so the timeline keeps flowing and
 * the app keeps working across daemon upgrades. This is the upgrade-compat seam.
 */

import type { TimelineEvent, WireEnvelope, WirePayload } from "@pounce/shared";

interface TranslateCtx {
  readonly conversationId: string;
}

export function translate(
  env: WireEnvelope,
  ctx: TranslateCtx,
): readonly TimelineEvent[] {
  const base = {
    conversationId: ctx.conversationId,
    seq: env.seq,
    ts: new Date(env.ts).toISOString(),
  };
  const id = `${ctx.conversationId}:${env.seq}`;
  // The wire is untyped JSON; this is the boundary that hand-validates it. Index
  // access keeps the loose-union catch-all from collapsing known fields to
  // `unknown`. Each case reads only the fields that variant is known to carry.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = env.payload as { type: string } & Record<string, any>;

  switch (p.type) {
    case "UserEnvelope":
      return [
        {
          ...base,
          id,
          type: "user_message",
          text: extractText(p.message),
        },
      ];

    case "AssistantEnvelope":
      return [
        {
          ...base,
          id,
          type: "assistant_message",
          text: extractText(p.message),
          streaming: false,
          ...(typeof p.ttftMs === "number" ? { ttftMs: p.ttftMs } : {}),
        },
      ];

    case "ContentBlockDelta":
      // Streaming text delta: the adapter coalesces these into the open
      // assistant message (see pounceAdapter). Emit a partial marker.
      return [
        {
          ...base,
          id,
          type: "assistant_message",
          text: extractDeltaText(p.delta),
          streaming: true,
        },
      ];

    case "ThinkingDelta":
      return [{ ...base, id, type: "thinking_started" }];

    case "ToolCall":
      return [
        {
          ...base,
          id,
          type: "tool_call",
          call: {
            id: p.toolCallId,
            name: p.toolName,
            input: p.arguments,
            status: "running",
            startedAt: base.ts,
          },
        },
      ];

    case "ToolResult":
      return [
        {
          ...base,
          id,
          type: "tool_result",
          result: {
            toolCallId: p.toolUseId,
            content: { kind: "json", value: p.content },
            isError: p.isError ?? false,
            durationMs: null,
          },
        },
      ];

    case "turn/completed":
      return [
        {
          ...base,
          id,
          type: "task_completed",
          taskId: env.runId,
          state: "completed",
        },
      ];

    case "SystemStatus":
      return [
        {
          ...base,
          id,
          type: "system_event",
          level: "info",
          message: p.subtype ? `${p.status}: ${p.subtype}` : p.status,
        },
      ];

    default:
      return [unknownToSystem(env, base, id)];
  }
}

function unknownToSystem(
  env: WireEnvelope,
  base: { conversationId: string; seq: number; ts: string },
  id: string,
): TimelineEvent {
  return {
    ...base,
    id,
    type: "system_event",
    level: "info",
    message: `unhandled event: ${env.payload.type}`,
    source: env.payload.type,
  };
}

/** Best-effort text extraction from the various message envelope shapes. */
function extractText(message: unknown): string {
  if (typeof message === "string") return message;
  if (message && typeof message === "object") {
    const m = message as Record<string, unknown>;
    if (typeof m.text === "string") return m.text;
    if (Array.isArray(m.content)) {
      return m.content
        .map((b) =>
          b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string"
            ? (b as { text: string }).text
            : "",
        )
        .join("");
    }
  }
  return "";
}

function extractDeltaText(delta: unknown): string {
  if (delta && typeof delta === "object") {
    const d = delta as Record<string, unknown>;
    if (typeof d.text === "string") return d.text;
  }
  return "";
}

/** Exposed for tests: every WirePayload type the translator handles. */
export const HANDLED_WIRE_TYPES: ReadonlySet<WirePayload["type"]> = new Set([
  "UserEnvelope",
  "AssistantEnvelope",
  "ContentBlockDelta",
  "ThinkingDelta",
  "ToolCall",
  "ToolResult",
  "turn/completed",
  "SystemStatus",
]);
