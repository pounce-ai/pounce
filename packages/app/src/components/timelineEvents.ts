/**
 * Pure timeline-event helpers — no React/RN imports, so they can be unit-tested
 * in isolation and reused without pulling in the Timeline component.
 */
import type { TimelineEvent } from "@litter/shared";

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
