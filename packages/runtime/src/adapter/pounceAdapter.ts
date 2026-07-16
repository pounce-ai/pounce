/**
 * PounceAdapter — the compatibility layer.
 *
 * Responsibilities (the daemon compatibility layer):
 *   - isolate the unstable alleycat transport behind one object
 *   - translate wire envelopes -> stable TimelineEvents
 *   - coalesce streaming assistant deltas into a single growing message
 *   - track the seq cursor so reconnects resume exactly (no gaps, no dupes)
 *
 * The app subscribes to {@link PounceAdapter.events} and never sees the wire.
 */

import type {
  CreateRunRequest,
  CreateRunResponse,
  RunControlRequest,
  TimelineEvent,
  WireEnvelope,
} from "@pounce/shared";
import type { Transport } from "../transport/types";
import { translate } from "./translate";

export type TimelineListener = (events: readonly TimelineEvent[]) => void;

export class PounceAdapter {
  #transport: Transport;
  /** Last seq applied per conversation — the resume cursor. */
  #cursors = new Map<string, number>();
  /** Open streaming assistant message text, keyed by conversation. */
  #openAssistant = new Map<string, { id: string; text: string; seq: number }>();

  constructor(transport: Transport) {
    this.#transport = transport;
  }

  get transport(): Transport {
    return this.#transport;
  }

  createRun(req: CreateRunRequest): Promise<CreateRunResponse> {
    return this.#transport.createRun(req);
  }

  control(req: RunControlRequest): Promise<void> {
    return this.#transport.controlRun(req);
  }

  cursorFor(conversationId: string): number | undefined {
    return this.#cursors.get(conversationId);
  }

  /**
   * Stream normalized timeline events for a conversation. Automatically resumes
   * from the last applied seq if we've seen this conversation before. Coalesces
   * streaming deltas so the UI sees one assistant message that grows.
   */
  async *events(
    conversationId: string,
    opts: { runId?: string; signal?: AbortSignal } = {},
  ): AsyncIterable<readonly TimelineEvent[]> {
    const sinceSeq = this.#cursors.get(conversationId);
    const stream = this.#transport.subscribe({
      conversationId,
      ...(opts.runId ? { runId: opts.runId } : {}),
      ...(sinceSeq != null ? { sinceSeq } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });

    for await (const env of stream) {
      const batch = this.#apply(conversationId, env);
      if (batch.length > 0) yield batch;
    }
  }

  /** Apply one envelope, updating cursor + streaming state, return UI events. */
  #apply(conversationId: string, env: WireEnvelope): readonly TimelineEvent[] {
    const prev = this.#cursors.get(conversationId);
    if (prev != null && env.seq <= prev) return []; // dedup on resume overlap
    this.#cursors.set(conversationId, env.seq);

    const translated = translate(env, { conversationId });
    const out: TimelineEvent[] = [];

    for (const ev of translated) {
      if (ev.type === "assistant_message" && ev.streaming) {
        const open = this.#openAssistant.get(conversationId);
        if (open) {
          open.text += ev.text;
          open.seq = ev.seq;
          out.push({ ...ev, id: open.id, text: open.text });
        } else {
          this.#openAssistant.set(conversationId, {
            id: ev.id,
            text: ev.text,
            seq: ev.seq,
          });
          out.push(ev);
        }
      } else if (ev.type === "assistant_message" && !ev.streaming) {
        this.#openAssistant.delete(conversationId);
        out.push(ev);
      } else {
        // A new user turn or turn completion finalizes the open stream: flip the
        // growing assistant message to its settled (non-streaming) form so the
        // caret disappears, keeping the same id (no duplicate bubble).
        if (ev.type === "user_message" || ev.type === "task_completed") {
          this.#finalizeOpen(conversationId, ev.ts, out);
        }
        out.push(ev);
      }
    }
    return out;
  }

  #finalizeOpen(
    conversationId: string,
    ts: string,
    out: TimelineEvent[],
  ): void {
    const open = this.#openAssistant.get(conversationId);
    if (!open) return;
    out.push({
      type: "assistant_message",
      id: open.id,
      conversationId,
      seq: open.seq,
      ts,
      text: open.text,
      streaming: false,
    });
    this.#openAssistant.delete(conversationId);
  }

  /** Reset resume state, e.g. after the replay floor evicted our cursor. */
  resetCursor(conversationId: string): void {
    this.#cursors.delete(conversationId);
    this.#openAssistant.delete(conversationId);
  }
}
