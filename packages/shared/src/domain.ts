/**
 * Stable domain model — the app's vocabulary.
 *
 * These types are the contract between the runtime adapter and the UI. They are
 * deliberately decoupled from the wire protocol so upstream alleycat changes are
 * absorbed in the adapter, never leaking into screens/state. Project-centric by
 * design: users think in Projects, never "sessions".
 */

import type { AgentId } from "./pairing";
import type { PermissionMode } from "./protocol";

export type ISODateString = string;
export type Id = string;

/** A host machine this client is paired with. */
export interface Host {
  readonly id: Id;
  readonly nodeId: string;
  readonly name: string;
  readonly online: boolean;
  readonly lastSeenAt: ISODateString;
}

/**
 * The primary object. A Project binds a working directory on a host to its
 * conversations, tasks and repository. One project ≈ one repo root on one host.
 */
export interface Project {
  readonly id: Id;
  readonly hostId: Id;
  readonly name: string;
  /** Absolute path on the host (the agent `cwd`). */
  readonly path: string;
  readonly defaultAgent: AgentId;
  readonly color: string;
  readonly createdAt: ISODateString;
  readonly lastActivityAt: ISODateString;
  /** Denormalized counters for list rendering without fanning out queries. */
  readonly activeTaskCount: number;
  readonly conversationCount: number;
}

export interface Conversation {
  readonly id: Id;
  readonly projectId: Id;
  readonly agent: AgentId;
  /** The agent-side thread id this conversation resumes. */
  readonly threadId: string | null;
  readonly title: string;
  readonly createdAt: ISODateString;
  readonly updatedAt: ISODateString;
  readonly messageCount: number;
  /** Replay cursor so a reconnecting client resumes exactly where it left off. */
  readonly seq: { readonly currentSeq: number; readonly floorSeq: number } | null;
}

export type TaskState =
  | "queued"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

/** Every AI action is a Task. Tasks are persisted and survive app restarts. */
export interface Task {
  readonly id: Id;
  readonly projectId: Id;
  readonly conversationId: Id;
  /** The daemon run id this task tracks (`/v1/runs`). */
  readonly runId: string | null;
  readonly title: string;
  readonly state: TaskState;
  readonly agent: AgentId;
  readonly createdAt: ISODateString;
  readonly startedAt: ISODateString | null;
  readonly completedAt: ISODateString | null;
  readonly progress: number | null;
  readonly error: string | null;
}

export interface Agent {
  readonly id: AgentId;
  readonly displayName: string;
  readonly available: boolean;
}

export type ToolStatus = "pending" | "running" | "success" | "error";

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
  readonly status: ToolStatus;
  readonly startedAt: ISODateString;
}

export interface ToolResult {
  readonly toolCallId: string;
  readonly content: ToolResultContent;
  readonly isError: boolean;
  readonly durationMs: number | null;
}

export type ToolResultContent =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "diff"; readonly path: string; readonly patch: string }
  | { readonly kind: "files"; readonly paths: readonly string[] }
  | { readonly kind: "image"; readonly data: string; readonly mediaType: string }
  | { readonly kind: "json"; readonly value: unknown };

/** Git working-tree state for a session (status/diff surface). */
export interface RepoGitState {
  readonly sessionId: Id;
  readonly branch: string;
  readonly baseBranch: string | null;
  readonly ahead: number;
  readonly behind: number;
  readonly files: readonly FileChange[];
}

export interface FileChange {
  readonly path: string;
  readonly status: "added" | "modified" | "deleted" | "renamed" | "untracked";
  readonly additions: number;
  readonly deletions: number;
}

/** Activity axis of the two-axis session status model. */
export type ActivityStatus =
  | "running"
  | "streaming"
  | "awaiting_input"
  | "completed"
  | "idle"
  | "failed"
  | "queued";

/**
 * A Session is the first-class object: one git worktree = one branch = one
 * agent = one conversation. Many sessions per repo; ephemeral (worktrees get
 * created, worked, merged, cleaned up → `isLive` false = archived history).
 */
export interface Session {
  readonly id: Id; // the daemon threadId
  readonly repoId: Id;
  /** The device (machine) this session runs on. */
  readonly hostId: Id;
  readonly host: string;
  readonly agent: AgentId;
  /** The task — derived from the first prompt / thread preview. */
  readonly title: string;
  readonly branch: string | null;
  readonly worktree: string | null;
  readonly cwd: string | null;
  /** Worktree exists on disk → can resume/steer. Else archived (read-only). */
  readonly isLive: boolean;
  readonly activity: ActivityStatus;
  /** Needs the user: awaiting input / failed / completed-unviewed. */
  readonly needsAttention: boolean;
  readonly createdAt: ISODateString;
  readonly updatedAt: ISODateString;
  /** The thread's current permission mode on the host (from its transcript), so
   *  the composer's mode picker reflects a terminal session's mode. */
  readonly permissionMode?: PermissionMode | null;
}

/** A paired machine running the alleycat daemon (Mac mini, Air, SSH box, …). */
export interface Device {
  readonly id: Id;
  readonly name: string;
  readonly url: string; // bridge url
  readonly online: boolean;
  readonly agents: readonly AgentId[];
  readonly sessionCount: number;
  readonly lastSyncAt: ISODateString;
}

/** A repository groups its sessions (worktrees). Never shows worktree paths. */
export interface Repository {
  readonly id: Id;
  readonly name: string;
  readonly sessionCount: number;
  readonly liveCount: number;
  readonly attentionCount: number;
  readonly lastActivityAt: ISODateString;
}

export interface UserProfile {
  readonly id: Id;
  readonly displayName: string;
  readonly defaultAgent: AgentId;
  readonly theme: "system" | "light" | "dark";
}
