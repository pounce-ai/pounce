/**
 * Remembering what a thread's activity was, between list rebuilds.
 *
 * The list is rebuilt from scratch every cache cycle and seeded before the real
 * reading is available — enrichment runs afterwards, asynchronously, over at
 * most the 30 newest threads. Without a memory of the last reading each rebuild
 * re-guessed, so a failed thread reported "completed" and then "failed" again a
 * moment later, and the app's attention shelf picked it up and dropped it on
 * that beat.
 *
 * What may be remembered is the whole design here, and it is narrower than "the
 * last thing we read".
 */

/**
 * A reading that stays true until something happens, so it can be carried
 * across a rebuild indefinitely.
 *
 * A thread only gets re-read while it is among the newest 30, and `isLive` is
 * no help as a filter — it means the working directory still exists, so it is
 * true for almost everything forever. Anything kept here is therefore kept
 * until that thread is in the window again, which for an older thread may be
 * never. These three survive that: a failed turn stays failed, a finished one
 * stays finished, until the thread moves.
 *
 * `awaiting_input` is deliberately in neither set: a pending prompt is live
 * state the bridge re-applies on every rebuild, and remembering it would strand
 * a thread as blocked after its prompt had been answered.
 */
const SETTLED = new Set(["failed", "completed", "idle"]);

/**
 * A turn in flight. Remembered too — but only briefly.
 *
 * These flicker for the same reason a failure did: the rebuild seeds a guess
 * and the response goes out before enrichment lands, so a running thread reads
 * `idle` on any poll that catches the wrong side of the cycle and the sidebar
 * moves it out of RUNNING and back. Refusing to remember them at all left that
 * half of the flicker in place.
 *
 * The freshness window is what makes it safe. A settled reading stays true
 * until something happens; "running" is only true for as long as nobody looked
 * away, and a thread that drops out of the enrichment window would otherwise
 * assert it forever — which isBusy() turns into a thread nobody can settle or
 * archive. Past the window we fall back to the guess, which is wrong for at
 * most one cycle and self-corrects, rather than wrong permanently.
 */
const TRANSIENT = new Set(["running", "streaming", "queued"]);
const TRANSIENT_TTL_MS = 60_000;

/** Map key. Thread ids are unique per agent, not globally. */
const keyOf = (t) => `${t.agent}:${t.id}`;

/**
 * Record a reading, if it is one of the kind worth keeping. Returns whether it
 * was kept, which is only of interest to tests.
 */
export function rememberActivity(memo, t, reading, now = Date.now()) {
  const activity = reading?.activity;
  if (!activity) return false;
  const transient = TRANSIENT.has(activity);
  if (!transient && !SETTLED.has(activity)) return false;
  memo.set(keyOf(t), {
    activity,
    lastActivityAt: reading.lastActivityAt,
    transient,
    at: now,
  });
  return true;
}

/**
 * Fill in a freshly listed thread's activity: the last real reading if we have
 * one, else the provisional guess that gets the list out of the door.
 *
 * An ARCHIVED thread — one whose directory has been deleted — ignores the memo.
 * Nothing can happen in it any more, so "completed" is true by construction and
 * a remembered reading could only ever be older news.
 */
export function seedActivity(memo, t, now = Date.now()) {
  if (!t.isLive) {
    t.activity = "completed";
    t.lastActivityAt = t.lastActivityAt ?? t.createdAt;
    return;
  }
  let known = memo.get(keyOf(t));
  // A stale "still working" reading is worse than no reading: see TRANSIENT.
  if (known?.transient && now - known.at > TRANSIENT_TTL_MS) known = undefined;
  t.activity = known?.activity ?? "idle";
  t.lastActivityAt = known?.lastActivityAt ?? t.createdAt;
}

/** Drop a thread's memory — for a thread that has gone away entirely. */
export function forgetActivity(memo, t) {
  memo.delete(keyOf(t));
}
