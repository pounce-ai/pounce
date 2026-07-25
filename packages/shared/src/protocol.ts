/**
 * Wire protocol — the *unstable* alleycat surface.
 *
 * Everything in this file is intentionally quarantined: it models the daemon's
 * HTTP/Iroh transport exactly as observed (`/v1/runs`, `/events`, seq replay,
 * `TurnStartParams`, ACP `CommandExec*`). The adapter layer in @pounce/runtime
 * is the ONLY place allowed to read these shapes; the app consumes the stable
 * domain/event types instead. This is the upgrade-compatibility seam.
 *
 * Recovered from the v0.3.4 binary symbols.
 */

import type { AgentId } from "./pairing";

/** Sequence cursor for the replayable event log (`SessionInfo`). */
export interface SeqCursor {
  /** Highest seq the server has emitted. */
  readonly currentSeq: number;
  /** Lowest seq still retained in the replay buffer (older is evicted). */
  readonly floorSeq: number;
}

/** A single framed event off the wire (SSE `data:` line or Iroh datagram). */
export interface WireEnvelope {
  readonly seq: number;
  readonly runId: string;
  readonly ts: number;
  /** Internally-tagged payload; `type` selects the variant. */
  readonly payload: WirePayload;
}

/**
 * Raw payload variants. This is a deliberately loose union — upstream adds
 * variants frequently, so unknown `type`s must survive translation as a
 * `system_event` rather than throwing. The adapter normalizes these.
 */
export type WirePayload =
  | { readonly type: "UserEnvelope"; readonly message: unknown }
  | { readonly type: "AssistantEnvelope"; readonly message: unknown; readonly ttftMs?: number }
  | { readonly type: "ContentBlockDelta"; readonly index: number; readonly delta: unknown }
  | {
      readonly type: "ToolCall";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly arguments: unknown;
    }
  | {
      readonly type: "ToolResult";
      readonly toolUseId: string;
      readonly content: unknown;
      readonly isError?: boolean;
    }
  | { readonly type: "ThinkingDelta"; readonly text: string }
  | { readonly type: "SystemStatus"; readonly status: string; readonly subtype?: string }
  | { readonly type: "RateLimitEnvelope"; readonly rateLimitInfo: unknown }
  | { readonly type: "turn/completed"; readonly durationMs?: number }
  | { readonly type: string; readonly [k: string]: unknown };

/**
 * Run/turn creation — `POST /v1/runs`, body ≈ `TurnStartParams` (16 fields in
 * the binary). We expose the mobile-relevant subset; the rest are defaulted
 * host-side.
 */
export interface CreateRunRequest {
  readonly agent: AgentId;
  /** Working directory on the host the turn runs against. */
  readonly cwd: string;
  /** Resume an existing agent thread instead of starting fresh. */
  readonly threadId?: string;
  readonly input: RunInput;
  readonly model?: string;
  readonly permissionMode?: PermissionMode;
  readonly reasoningEffort?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
}

export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan";

export interface RunInput {
  readonly text: string;
  readonly images?: readonly RunImage[];
}

export interface RunImage {
  /** base64 payload (daemon accepts image/png|jpeg|gif|webp|bmp). */
  readonly data: string;
  readonly mediaType: string;
}

export interface CreateRunResponse {
  readonly runId: string;
  readonly threadId: string;
  readonly seq: SeqCursor;
}

/** Turn lifecycle controls (`TurnInterruptParams`, `stop_task`, `abort`). */
export interface RunControlRequest {
  readonly runId: string;
  readonly action: "interrupt" | "stop" | "pause" | "resume" | "cancel";
}

/** Terminal — ACP `CommandExecParams` family (shell-bridge). */
export interface ExecRequest {
  readonly cwd: string;
  readonly command: string;
  readonly terminalId?: string;
  readonly cols?: number;
  readonly rows?: number;
  readonly background?: boolean;
}

export interface ExecWriteRequest {
  readonly terminalId: string;
  readonly data: string;
}

export interface ExecResizeRequest {
  readonly terminalId: string;
  readonly cols: number;
  readonly rows: number;
}

/** Git/review surface (`ReviewTarget::UncommittedChanges`, `commit`). */
export interface GitStatusRequest {
  readonly cwd: string;
}

export interface GitCommitRequest {
  readonly cwd: string;
  readonly message: string;
  readonly files?: readonly string[];
}

export interface DiffRequest {
  readonly cwd: string;
  readonly baseBranch?: string;
  /** Default: uncommitted working-tree changes. */
  readonly target?: "uncommitted" | "staged" | "branch";
}
