/**
 * Which threads count as settled — the rule behind the inbox.
 *
 * Pure and shared, because it is a SAFETY rule and not a display preference:
 * every surface that hides a settled thread has to hide exactly the same set,
 * and the one thing an inbox must never do is bury work that is waiting on you.
 */
import type { Session } from "@pounce/shared";
import { needsYou } from "./sessionRules";

const DAY_MS = 24 * 60 * 60 * 1000;

/** T3 Code's default, and ours: three quiet days and a thread settles itself. */
export const AUTO_SETTLE_DEFAULT_DAYS = 3;

/**
 * What the user said about a thread, if anything.
 *
 * TWO directions, not a boolean, because auto-settle needs both. "settled" is
 * the ordinary gesture; "active" only becomes necessary once threads settle on
 * their own — without it, un-settling a week-old thread would do nothing at
 * all, since the inactivity rule would settle it again on the same render and
 * the button would look broken.
 *
 * `at` is when the user said it, and it is compared against the thread's own
 * `updatedAt`: an override older than the thread's last activity has been
 * overtaken by events and is ignored in BOTH directions.
 */
export interface SettleOverride {
  readonly state: "settled" | "active";
  readonly at: string;
}

export type SettleOverrides = Readonly<Record<string, SettleOverride>>;

export interface SettleOptions {
  /** ISO now. Passed in rather than read, so one list renders one consistent
   *  answer and the rule stays testable. */
  readonly now: string;
  /** Quiet days before a thread settles itself; null disables it entirely. */
  readonly autoSettleAfterDays: number | null;
}

/**
 * Work in progress, or work blocked on the user.
 *
 * This OUTRANKS everything below — a user's settle and auto-settle alike. A
 * settled thread that starts running, fails, or asks a question comes straight
 * back to the active list, and a busy thread cannot be settled in the first
 * place. Without that rule an inbox is a way to lose things, which is why it is
 * checked before anything else.
 */
export function isBusy(s: Session): boolean {
  return (
    needsYou(s) || s.activity === "running" || s.activity === "streaming" || s.activity === "queued"
  );
}

/** An override the thread's own activity has already overtaken. */
function stale(s: Session, o: SettleOverride): boolean {
  const at = Date.parse(o.at);
  if (Number.isNaN(at)) return true;
  const touched = Date.parse(s.updatedAt);
  // An unreadable thread timestamp must not silently discard a deliberate act.
  if (Number.isNaN(touched)) return false;
  return touched > at;
}

/**
 * Settled resolution. The order is the whole rule:
 *
 *   1. busy or blocked   → active, whatever anyone said
 *   2. a live override   → exactly what the user said, both directions
 *   3. quiet for N days  → settled
 *
 * Step 2 is what makes auto-unsettle free: an override only counts while the
 * thread hasn't moved since, so any new turn, reply or status change drops
 * through to step 3 on its own. Nothing watches for activity, so nothing can
 * miss it.
 */
export function isSettled(
  s: Session,
  override: SettleOverride | undefined,
  opts: SettleOptions,
): boolean {
  if (isBusy(s)) return false;
  if (override && !stale(s, override)) return override.state === "settled";
  if (opts.autoSettleAfterDays == null) return false;
  const touched = Date.parse(s.updatedAt);
  // Bad data never hides a thread.
  if (Number.isNaN(touched)) return false;
  return touched < Date.parse(opts.now) - opts.autoSettleAfterDays * DAY_MS;
}

/** Whether the settle gesture should be offered at all — same blockers, so the
 *  control is never shown for something that would spring straight back. */
export function canSettle(s: Session): boolean {
  return !isBusy(s);
}

/**
 * Split a sorted list into what is still open and what has been settled.
 *
 * Settled rows are ordered by the most recent thing that happened to them —
 * their own activity, or the moment the user cleared them, whichever is later.
 * The section is a record of what you finished with, so what you just settled
 * sits at the top where you can get it back.
 */
export function partitionSettled(
  sessions: readonly Session[],
  overrides: SettleOverrides,
  opts: SettleOptions,
): { active: Session[]; settled: Session[] } {
  const active: Session[] = [];
  const settled: Session[] = [];
  for (const s of sessions) {
    (isSettled(s, overrides[s.id], opts) ? settled : active).push(s);
  }
  const clearedAt = (s: Session) =>
    Math.max(Date.parse(s.updatedAt) || 0, Date.parse(overrides[s.id]?.at ?? "") || 0);
  settled.sort((a, b) => clearedAt(b) - clearedAt(a));
  return { active, settled };
}
