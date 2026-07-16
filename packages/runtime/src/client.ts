/**
 * PounceRuntime — the high-level facade the app talks to.
 *
 * Wraps a {@link PounceAdapter} (which wraps a {@link Transport}) and exposes
 * project/conversation/task operations in domain terms. Screens and hooks use
 * this; they never import a transport or wire type directly.
 */

import type {
  AgentInfo,
  Conversation,
  DiffRequest,
  GitCommitRequest,
  HostStatus,
  PairPayload,
  PermissionMode,
  Project,
  RunImage,
  TimelineEvent,
} from "@pounce/shared";
import { PounceAdapter } from "./adapter/pounceAdapter";
import type { ConnectionState, Transport } from "./transport/types";

export interface SendMessageInput {
  readonly conversation: Conversation;
  readonly project: Project;
  readonly text: string;
  readonly images?: readonly RunImage[];
  readonly model?: string;
  readonly permissionMode?: PermissionMode;
}

export class PounceRuntime {
  #adapter: PounceAdapter;

  constructor(transport: Transport) {
    this.#adapter = new PounceAdapter(transport);
  }

  static withTransport(transport: Transport): PounceRuntime {
    return new PounceRuntime(transport);
  }

  get adapter(): PounceAdapter {
    return this.#adapter;
  }

  connect(pairing: PairPayload): Promise<HostStatus> {
    return this.#adapter.transport.connect(pairing);
  }

  disconnect(): Promise<void> {
    return this.#adapter.transport.disconnect();
  }

  onConnectionStateChange(cb: (s: ConnectionState) => void): () => void {
    return this.#adapter.transport.onStateChange(cb);
  }

  listAgents(): Promise<readonly AgentInfo[]> {
    return this.#adapter.transport.listAgents();
  }

  /**
   * Send a message — every send is a run/turn, and therefore a Task. Returns
   * the runId so the caller can create/track the Task and subscribe.
   */
  async sendMessage(
    input: SendMessageInput,
  ): Promise<{ runId: string; threadId: string }> {
    const res = await this.#adapter.createRun({
      agent: input.conversation.agent,
      cwd: input.project.path,
      ...(input.conversation.threadId
        ? { threadId: input.conversation.threadId }
        : {}),
      input: {
        text: input.text,
        ...(input.images ? { images: input.images } : {}),
      },
      ...(input.model ? { model: input.model } : {}),
      ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
    });
    return { runId: res.runId, threadId: res.threadId };
  }

  pauseTask(runId: string): Promise<void> {
    return this.#adapter.control({ runId, action: "pause" });
  }
  resumeTask(runId: string): Promise<void> {
    return this.#adapter.control({ runId, action: "resume" });
  }
  cancelTask(runId: string): Promise<void> {
    return this.#adapter.control({ runId, action: "cancel" });
  }

  /** Subscribe to a conversation's normalized timeline (auto-resumes by seq). */
  subscribe(
    conversationId: string,
    opts: { runId?: string; signal?: AbortSignal } = {},
  ): AsyncIterable<readonly TimelineEvent[]> {
    return this.#adapter.events(conversationId, opts);
  }

  gitDiff(req: DiffRequest): Promise<string> {
    return this.#adapter.transport.gitDiff(req);
  }
  gitCommit(req: GitCommitRequest): Promise<void> {
    return this.#adapter.transport.gitCommit(req);
  }
}
