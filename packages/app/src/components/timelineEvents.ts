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
 * Wall-clock every run took: earliest call started → latest result landed, per
 * run. Reads the RAW event list because `collapseToolResults` folds results into
 * their call and drops the rows carrying the finishing timestamp.
 *
 * ALL runs in two passes, not two passes per run. This runs again on every
 * streamed token, and per-run scanning made it O(runs × events) — quadratic in
 * thread length, on the one path that has to keep up with a live turn.
 *
 * A run is absent from the result when it's still open (no results yet), when no
 * call carried a usable timestamp, or when it spans under a second — "Worked for
 * 0s" is worse than saying nothing.
 */
export function runElapsedByRun(
  events: TimelineEvent[],
  runs: readonly { id: string; ids: readonly string[] }[],
): Map<string, number> {
  const runOfCall = new Map<string, string>();
  for (const run of runs) for (const id of run.ids) runOfCall.set(id, run.id);

  const span = new Map<string, { start: number; end: number }>();
  // A result names its call, not its run — so the first pass records which run
  // each call key belongs to and the second folds the results in.
  const runOfCallKey = new Map<string, string>();
  for (const e of events) {
    if (e.type !== "tool_call") continue;
    const runId = runOfCall.get(e.id);
    if (!runId) continue;
    runOfCallKey.set(e.call.id || e.id, runId);
    const t = Date.parse(e.ts);
    if (Number.isNaN(t)) continue;
    const seen = span.get(runId);
    if (!seen) span.set(runId, { start: t, end: t });
    else {
      if (t < seen.start) seen.start = t;
      if (t > seen.end) seen.end = t;
    }
  }
  for (const e of events) {
    if (e.type !== "tool_result") continue;
    const runId = runOfCallKey.get(e.result.toolCallId || e.id.replace(/:o$/, ""));
    const seen = runId ? span.get(runId) : undefined;
    if (!seen) continue;
    const t = Date.parse(e.ts);
    if (!Number.isNaN(t) && t > seen.end) seen.end = t;
  }

  const out = new Map<string, number>();
  for (const [runId, { start, end }] of span) if (end - start >= 1000) out.set(runId, end - start);
  return out;
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
