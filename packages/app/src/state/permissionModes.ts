/**
 * Which permission mode the picker should show, when the host reports one.
 *
 * Reflecting the thread's real mode is right: a thread started in `plan` from a
 * terminal should not show "default" in the app, because that is a lie about
 * what the next turn will do.
 *
 * Adopting it unconditionally is not. Taking over a thread that was running in
 * `acceptEdits` silently moved the picker — and therefore the user — into a
 * mode that approves file writes without asking. Nobody chose that; a thread
 * they opened chose it for them, and the only notice was a control they were
 * not looking at.
 *
 * So: follow the host DOWN, never UP. A more restrictive mode is adopted (it
 * can only reduce what happens next); a more permissive one is left for the
 * person to pick deliberately.
 */
import type { PermissionMode } from "@pounce/shared";

/**
 * How much a mode allows. Ordered, so "more permissive" is a comparison.
 *
 * These names are ours, not any agent's. Claude Code calls them `normal` and
 * `auto`; agents/claude.mjs maps those onto this vocabulary and turns anything
 * it does not recognise into null, so an unfamiliar mode never arrives here.
 */
const PERMISSIVENESS: Record<PermissionMode, number> = {
  plan: 0,
  default: 1,
  acceptEdits: 2,
  bypassPermissions: 3,
};

/**
 * An unknown mode ranks as maximally permissive, so it can never be adopted
 * over something the user is showing.
 *
 * Not theoretical: this is a hardcoded list, one of three that have to agree
 * (the union in @pounce/shared, the bridge's per-agent alias map, and the
 * picker's own options). A mode added to one and not the others would otherwise
 * sail past the check below — `undefined > 1` is false, which reads as "not an
 * escalation" and adopts it. Failing closed costs a stale picker; failing open
 * costs a permission nobody granted.
 */
const rank = (m: PermissionMode): number => PERMISSIVENESS[m] ?? Number.POSITIVE_INFINITY;

/**
 * The mode to display, given what is shown now and what the host reports.
 *
 * `shown` undefined means the agent's own default — nothing has been chosen, so
 * there is no user decision to protect and the host's word is the best answer.
 */
export function adoptedMode(
  shown: PermissionMode | undefined,
  reported: PermissionMode | null | undefined,
): PermissionMode | undefined {
  if (!reported) return shown;
  if (!shown) return reported;
  return rank(reported) > rank(shown) ? shown : reported;
}

/** Whether moving from `shown` to `reported` would loosen what an agent may do
 *  without asking — the transition that must never happen on its own. */
export function isEscalation(
  shown: PermissionMode | undefined,
  reported: PermissionMode | null | undefined,
): boolean {
  if (!shown || !reported) return false;
  return rank(reported) > rank(shown);
}
