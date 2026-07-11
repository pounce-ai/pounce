/**
 * useTimeline — subscribes to a conversation's normalized event stream and
 * exposes a stable, seq-ordered array for the virtualized list.
 *
 * The adapter already coalesces streaming deltas and dedups on resume, so here
 * we only merge incoming batches into a map keyed by event id (a streaming
 * assistant message keeps one id while it grows, so it updates in place).
 */
import { useEffect, useRef, useState, useCallback } from "react";
import type { TimelineEvent } from "@litter/shared";
import { getRuntime } from "../services/runtime";

export interface TimelineState {
  events: TimelineEvent[];
  connected: boolean;
  error: string | null;
}

export function useTimeline(
  conversationId: string,
  runId?: string,
  enabled = true,
): TimelineState & { retry: () => void } {
  const [state, setState] = useState<TimelineState>({
    events: [],
    connected: false,
    error: null,
  });
  const byId = useRef(new Map<string, TimelineEvent>());
  const [nonce, setNonce] = useState(0);

  const retry = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!enabled) return;
    const ac = new AbortController();
    let cancelled = false;

    (async () => {
      try {
        const rt = await getRuntime();
        setState((s) => ({ ...s, connected: true, error: null }));
        const stream = rt.subscribe(conversationId, {
          ...(runId ? { runId } : {}),
          signal: ac.signal,
        });
        for await (const batch of stream) {
          if (cancelled) break;
          for (const ev of batch) byId.current.set(ev.id, ev);
          const events = [...byId.current.values()].sort((a, b) => a.seq - b.seq);
          setState((s) => ({ ...s, events }));
        }
      } catch (err) {
        if (!cancelled) {
          setState((s) => ({
            ...s,
            connected: false,
            error: err instanceof Error ? err.message : String(err),
          }));
        }
      }
    })();

    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [conversationId, runId, nonce, enabled]);

  return { ...state, retry };
}
