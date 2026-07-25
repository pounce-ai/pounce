/**
 * Timeline events — the single stream the UI renders.
 *
 * Everything in a conversation is one of these, virtualized through one list.
 * This is the normalized form the adapter produces from {@link WireEnvelope}s.
 * The spec's event taxonomy maps 1:1 onto the `type` discriminant below.
 */

import type { Id, ISODateString, TaskState, ToolCall, ToolResult } from "./domain";

interface TimelineBase {
  readonly id: Id;
  readonly conversationId: Id;
  /** Monotonic seq from the daemon — also the stable sort + dedup key. */
  readonly seq: number;
  readonly ts: ISODateString;
}

export interface UserMessageEvent extends TimelineBase {
  readonly type: "user_message";
  readonly text: string;
  readonly images?: readonly MessageImage[];
}

/** An attached image. The bridge sends a lightweight `ref`; the client resolves
 *  it to a loadable `uri` (a token-authed bridge URL) in fetchMessages. `data`
 *  is the legacy inline-base64 path (locally-composed / sent images). */
export interface MessageImage {
  readonly mediaType: string;
  readonly ref?: string;
  readonly uri?: string;
  readonly data?: string;
}

export interface AssistantMessageEvent extends TimelineBase {
  readonly type: "assistant_message";
  readonly text: string;
  /** True while deltas are still streaming into this message. */
  readonly streaming: boolean;
  readonly ttftMs?: number;
}

export interface ThinkingStartedEvent extends TimelineBase {
  readonly type: "thinking_started";
}

export interface ThinkingFinishedEvent extends TimelineBase {
  readonly type: "thinking_finished";
  readonly text: string;
  readonly durationMs: number;
}

export interface ToolCallEvent extends TimelineBase {
  readonly type: "tool_call";
  readonly call: ToolCall;
}

export interface ToolResultEvent extends TimelineBase {
  readonly type: "tool_result";
  readonly result: ToolResult;
}

export interface TaskEvent extends TimelineBase {
  readonly type:
    | "task_created"
    | "task_started"
    | "task_progress"
    | "task_completed"
    | "task_failed";
  readonly taskId: Id;
  readonly state: TaskState;
  readonly progress?: number;
  readonly error?: string;
}

export interface GitEvent extends TimelineBase {
  readonly type: "git_event";
  readonly action: "status" | "commit" | "branch" | "diff";
  readonly summary: string;
  readonly files?: readonly string[];
}

export interface TerminalEvent extends TimelineBase {
  readonly type: "terminal_event";
  readonly terminalId: string;
  readonly stream: "stdout" | "stderr" | "exit";
  readonly data: string;
  readonly exitCode?: number;
}

export interface SystemEvent extends TimelineBase {
  readonly type: "system_event";
  readonly level: "info" | "warning" | "error";
  readonly message: string;
  /** Preserved raw `type` when an unknown upstream variant was normalized. */
  readonly source?: string;
}

/** One choice offered for a pending permission (ACP `session/request_permission`). */
export interface PermissionOption {
  readonly optionId: string;
  readonly name: string;
  /** allow_once | allow_always | reject_once | reject_always | … */
  readonly kind?: string;
}

/**
 * An agent (over ACP) is asking the user to approve a tool call before it runs.
 * The client renders the options; the chosen `optionId` is POSTed back to the
 * bridge, which resolves the paused turn. Only appears on ACP-driven live turns.
 */
export interface PermissionRequestEvent extends TimelineBase {
  readonly type: "permission_request";
  readonly requestId: string;
  readonly toolName: string;
  readonly toolTitle: string;
  readonly options: readonly PermissionOption[];
}

/** One selectable option in an interactive prompt. */
export interface PromptOption {
  readonly label: string;
}

/**
 * The hosted CLI is blocked on an interactive prompt and the app can answer it.
 * This is GENERIC and agent-agnostic: trust-folder, tool permission, plan-mode
 * approval, AskUserQuestion — every one renders as a numbered on-screen menu, so
 * the bridge detects it from the terminal SCREEN (not a per-agent transcript
 * call) and surfaces the same shape. The app renders the options; the chosen
 * index is POSTed back, and the bridge moves the on-screen highlight there and
 * presses Enter. `kind` is a cosmetic hint for UI copy only. Free-form prompts
 * are handled by sending raw input instead. Only on PTY-hosted sessions.
 */
export interface PromptRequestEvent extends TimelineBase {
  readonly type: "prompt_request";
  readonly promptId: string;
  readonly title: string;
  readonly kind: string; // "trust" | "permission" | "plan" | "prompt"
  readonly options: readonly PromptOption[];
  readonly highlighted: number; // index the CLI currently has highlighted
  readonly multiSelect: boolean;
}

/** The discriminated union the timeline list switches over. */
export type TimelineEvent =
  | UserMessageEvent
  | AssistantMessageEvent
  | ThinkingStartedEvent
  | ThinkingFinishedEvent
  | ToolCallEvent
  | ToolResultEvent
  | TaskEvent
  | GitEvent
  | TerminalEvent
  | SystemEvent
  | PermissionRequestEvent
  | PromptRequestEvent;

export type TimelineEventType = TimelineEvent["type"];

/** Narrowing helper for exhaustive switches in renderers. */
export function assertNeverEvent(e: never): never {
  throw new Error(`Unhandled timeline event: ${JSON.stringify(e)}`);
}
