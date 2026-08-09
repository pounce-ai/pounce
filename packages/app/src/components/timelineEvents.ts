/**
 * Pure timeline-event helpers — no React/RN imports, so they can be unit-tested
 * in isolation and reused without pulling in the Timeline component.
 */
import type { TimelineEvent } from "@pounce/shared";

function toolCallIds(events: TimelineEvent[]): Set<string> {
  const s = new Set<string>();
  for (const e of events) if (e.type === "tool_call") s.add(e.call.id || e.id);
  return s;
}

/**
 * Drop tool_result rows whose call renders them inline as an accordion, then
 * dedup by id. The session screen runs its marker indices through this same
 * function so marker jumps stay aligned with the list Timeline actually renders.
 *
 * Dedup by id: a streamed live event and its re-parsed transcript twin can
 * briefly coexist with the same id (e.g. right after a turn completes);
 * LegendList's keyExtractor rejects the collision ("Detected overlapping
 * key …"), dropping rows and gapping the list. Keep the LAST occurrence — the
 * authoritative transcript copy (and the one fetchMessages resolves a previewUri
 * onto) — in stable order.
 */
/**
 * Wall-clock a run of tool calls took: earliest call started → latest result
 * landed. Reads the RAW event list because `collapseToolResults` folds results
 * into their call and drops the rows that carry the finishing timestamp.
 *
 * Null when the run is still open (no results yet) or spans under a second —
 * "Worked for 0s" is worse than saying nothing.
 */
export function runElapsedMs(events: TimelineEvent[], runIds: readonly string[]): number | null {
  const inRun = new Set(runIds);
  const callKeys = new Set<string>();
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const e of events) {
    if (e.type !== "tool_call" || !inRun.has(e.id)) continue;
    const t = Date.parse(e.ts);
    if (!Number.isNaN(t)) {
      start = Math.min(start, t);
      end = Math.max(end, t);
    }
    callKeys.add(e.call.id || e.id);
  }
  if (!Number.isFinite(start)) return null;
  for (const e of events) {
    if (e.type !== "tool_result") continue;
    if (!callKeys.has(e.result.toolCallId || e.id.replace(/:o$/, ""))) continue;
    const t = Date.parse(e.ts);
    if (!Number.isNaN(t)) end = Math.max(end, t);
  }
  const ms = end - start;
  return ms >= 1000 ? ms : null;
}

/** "22s", "1m 30s", "2m" — the shape t3code's working timer uses. */
export function formatElapsed(ms: number): string {
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

export function collapseToolResults(events: TimelineEvent[]): TimelineEvent[] {
  const calls = toolCallIds(events);
  const filtered = events.filter(
    (e) => !(e.type === "tool_result" && calls.has(e.result.toolCallId || e.id.replace(/:o$/, ""))),
  );
  const seen = new Set<string>();
  const out: TimelineEvent[] = [];
  for (let i = filtered.length - 1; i >= 0; i--) {
    const e = filtered[i];
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  out.reverse();
  return out;
}
