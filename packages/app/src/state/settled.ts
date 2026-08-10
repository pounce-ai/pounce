/**
 * Which threads count as settled — the rule behind the inbox.
 *
 * Pure and shared, because it is a SAFETY rule and not a display preference:
 * every surface that hides a settled thread has to hide exactly the same set,
 * and the one thing an inbox must never do is bury work that is waiting on you.
 */
import type { Session } from "@pounce/shared";
import { needsYou } from "./sessionRules";

/**
 * Work in progress, or work blocked on the user.
 *
 * This OUTRANKS a settle in both directions: a settled thread that starts
 * running, fails, or asks a question comes straight back to the active list,
 * and a busy thread cannot be settled in the first place. Without that rule an
 * inbox is a way to lose things — which is why it is checked before the
 * timestamp rather than after it.
 */
export function isBusy(s: Session): boolean {
  return (
    needsYou(s) || s.activity === "running" || s.activity === "streaming" || s.activity === "queued"
  );
}

/**
 * Settled as of `settledAt`, and nothing has happened since.
 *
 * The comparison against the thread's own `updatedAt` is what makes
 * auto-unsettle free: a new turn, a reply, or any status change moves
 * `updatedAt` past the settle stamp and the thread returns to the active list
 * on its own. Nothing watches for activity, so nothing can miss it — and a
 * settle can never go stale, because it only ever describes a moment.
 *
 * A missing or unparseable stamp means "not settled": bad data must never hide
 * a thread.
 */
export function isSettled(s: Session, settledAt: string | undefined): boolean {
  if (!settledAt) return false;
  if (isBusy(s)) return false;
  const at = Date.parse(settledAt);
  if (Number.isNaN(at)) return false;
  const touched = Date.parse(s.updatedAt);
  if (Number.isNaN(touched)) return true;
  return touched <= at;
}

/** Whether the settle gesture should be offered at all. Same blockers as
 *  `isSettled`, so the button is never shown for something that would spring
 *  straight back. */
export function canSettle(s: Session): boolean {
  return !isBusy(s);
}

/**
 * Split a sorted list into what is still open and what has been settled.
 *
 * Settled rows are ordered by WHEN THEY WERE SETTLED, newest first — not by
 * thread activity. The section is a record of what you just cleared, so the
 * thing you settled a moment ago is the one you might want back.
 */
export function partitionSettled(
  sessions: readonly Session[],
  settledAt: Readonly<Record<string, string>>,
): { active: Session[]; settled: Session[] } {
  const active: Session[] = [];
  const settled: Session[] = [];
  for (const s of sessions) (isSettled(s, settledAt[s.id]) ? settled : active).push(s);
  settled.sort((a, b) => Date.parse(settledAt[b.id]) - Date.parse(settledAt[a.id]));
  return { active, settled };
}
