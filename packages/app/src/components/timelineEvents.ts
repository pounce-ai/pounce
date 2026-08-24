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
  return dropRepeatedThought(out);
}

/**
 * Drop a Thought that only restates the one directly above it.
 *
 * The same reasoning reaches the list twice more easily than it looks: an agent
 * re-persists a reasoning record when it rebuilds context, and a live event and
 * its transcript twin can slip past the id/content match upstream. Both draw two
 * cards a reader cannot tell apart — pure noise in a view where a Thought is
 * already the least interesting row on screen.
 *
 * ADJACENT only, and by rendered text. A thought repeated later in a thread is
 * the agent genuinely circling back, which is worth seeing; one repeated with
 * nothing in between never is.
 */
function dropRepeatedThought(events: TimelineEvent[]): TimelineEvent[] {
  let prev: string | null = null;
  return events.filter((e) => {
    if (e.type !== "thinking_finished") {
      prev = null;
      return true;
    }
    const text = normalizeText(e.text);
    const repeat = text.length > 0 && text === prev;
    prev = text;
    return !repeat;
  });
}

/** Text as it will READ once rendered — whitespace runs collapsed and trimmed.
 *  Only for comparing two copies of the same words, never for display. */
function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function sameText(a: string, b: string): boolean {
  return a === b || normalizeText(a) === normalizeText(b);
}

/** True when `b` is the transcript re-parse of streamed event `a`. The daemon
 *  mints fresh event ids when it re-reads the transcript after a turn, so id
 *  equality alone can't collapse a finished turn's streamed copy against the
 *  fetched one — without this, the whole reply renders twice at completion. */
export function isEquivalentEvent(a: TimelineEvent, b: TimelineEvent): boolean {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case "user_message":
    case "assistant_message":
    case "thinking_finished":
      // Compare NORMALIZED text, not raw. The live stream and the transcript
      // re-parse of the same words are assembled differently by every adapter —
      // codex joins a reasoning item's summary parts with "\n" on the way out of
      // the rollout while the live event carries the CLI's own `it.text`, and
      // assistant history additionally goes through fenceJson. Under strict
      // equality a separator's worth of whitespace was enough to miss the match,
      // and the two copies then rendered as two rows that markdown drew
      // identically: the duplicated "Thought" card in a codex session.
      return sameText(a.text, (b as typeof a).text);
    case "tool_call":
      return a.call.id === (b as typeof a).call.id;
    case "tool_result":
      return a.result.toolCallId === (b as typeof a).result.toolCallId;
    default:
      return false;
  }
}

export function mergeById(cur: TimelineEvent[], inc: TimelineEvent[]): TimelineEvent[] {
  const out = cur.slice();
  const idx = new Map(out.map((e, i) => [e.id, i] as const));
  for (const ev of inc) {
    const i = idx.get(ev.id);
    if (i != null) out[i] = ev;
    else {
      idx.set(ev.id, out.length);
      out.push(ev);
    }
  }
  return out;
}

/** Fold a fetched transcript into the rendered list without disturbing rows
 *  already on screen. A fetched event matching a rendered one only by content
 *  (re-parses mint fresh ids) is dropped in favor of the RENDERED event — its
 *  row keeps its key, so the just-streamed reply never remounts/re-measures at
 *  the exact moment the anchor spacer collapses. (Swapping to the fetched copy
 *  reset the row to its estimated size and scroll-to-end then landed at the
 *  START of the message.) Rendered extras the transcript hasn't flushed yet are
 *  kept — the render list only ever accretes. */
export function reconcileFetched(cur: TimelineEvent[], fetched: TimelineEvent[]): TimelineEvent[] {
  if (!cur.length) return fetched;
  const used = new Set<string>();
  const next = fetched.map((f) => {
    const match = cur.find((e) => !used.has(e.id) && (e.id === f.id || isEquivalentEvent(e, f)));
    if (!match) return f;
    used.add(match.id);
    // Adopt the fetched (canonical) payload — it carries the settled flags,
    // e.g. assistant_message.streaming=false, which flips the row off the
    // streaming renderer — but under the RENDERED id, so the row's key and
    // measurement survive.
    return match.id === f.id ? f : { ...f, id: match.id };
  });
  const extras = cur.filter(
    (e) => !used.has(e.id) && !e.id.startsWith("opt:") && !next.some((f) => f.id === e.id),
  );
  return extras.length ? mergeById(next, extras) : next;
}

/**
 * What the render list should hold after a turn finishes and its thread's
 * transcript has been re-read.
 *
 * The re-read is authoritative only when it covers at least the history that
 * was already on screen before this turn. Anything shorter is a FAILED or
 * PARTIAL read, not a shorter thread: the transcript can be missing (a turn
 * that died before the agent wrote one — the plan's usage running out mid-turn
 * does this), not flushed yet, or belong to a different session than the thread
 * we are in. Adopting one of those replaced the whole timeline with the single
 * turn that just ran, which is how a thread lost its past to one failed send.
 *
 * Folding the short read in anyway is not an option either: reconcileFetched
 * appends unmatched rendered rows AFTER the fetched ones, which is right for a
 * flush-lagging tail and wrong for a whole history. So keep what's rendered and
 * let the next sync tick supersede it.
 *
 * @param cur        the render list as it stands (already carries `streamed`)
 * @param streamed   events this turn streamed
 * @param fetched    the re-read transcript, in chronological order
 */
export function foldTurnRefetch(
  cur: TimelineEvent[],
  streamed: TimelineEvent[],
  fetched: TimelineEvent[],
): TimelineEvent[] {
  const prior = Math.max(0, cur.length - streamed.length);
  if (fetched.length < prior) return mergeById(cur, streamed);
  // Older history is id-stable across fetches; only this turn's streamed rows
  // need their identity preserved (see reconcileFetched).
  return reconcileFetched(streamed, fetched);
}
