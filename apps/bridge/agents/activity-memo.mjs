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
 * States worth carrying across a rebuild.
 *
 * A thread only gets re-read while it is among the newest 30, and `isLive` is
 * not a filter that helps — it means the working directory still exists, so it
 * is true for almost everything forever. So anything remembered here is
 * remembered until the thread happens to be in that window again, which for an
 * older thread may be never.
 *
 * That is fine for a settled reading and wrong for a transient one. `running`,
 * `streaming` and `queued` describe a turn IN FLIGHT: they are only true for as
 * long as nobody looks away, they are re-read on every pass while the thread is
 * in the window (so nothing needs to remember them), and pinning one is not a
 * cosmetic error — `isBusy` treats a running thread as unsettleable, so a
 * thread stuck that way can never be dismissed or archived by anyone.
 *
 * `awaiting_input` is absent for a different reason: a pending prompt is live
 * state the bridge re-applies on every rebuild, and remembering it would strand
 * a thread as blocked after its prompt had been answered.
 */
const REMEMBERED = new Set(["failed", "completed", "idle"]);

/** Map key. Thread ids are unique per agent, not globally. */
const keyOf = (t) => `${t.agent}:${t.id}`;

/**
 * Record a reading, if it is one of the kind worth keeping. Returns whether it
 * was kept, which is only of interest to tests.
 */
export function rememberActivity(memo, t, reading) {
  if (!reading?.activity || !REMEMBERED.has(reading.activity)) return false;
  memo.set(keyOf(t), {
    activity: reading.activity,
    lastActivityAt: reading.lastActivityAt,
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
export function seedActivity(memo, t) {
  if (!t.isLive) {
    t.activity = "completed";
    t.lastActivityAt = t.lastActivityAt ?? t.createdAt;
    return;
  }
  const known = memo.get(keyOf(t));
  t.activity = known?.activity ?? "idle";
  t.lastActivityAt = known?.lastActivityAt ?? t.createdAt;
}

/** Drop a thread's memory — for a thread that has gone away entirely. */
export function forgetActivity(memo, t) {
  memo.delete(keyOf(t));
}
