/**
 * The inbox's state: what the user has said about each thread, and how long a
 * thread may sit quiet before it settles itself.
 *
 * The OVERRIDES are bridge-owned (see agents/settled.mjs) so settling on the
 * phone settles on the desktop. The POLICY is a local preference, like the
 * theme: it decides how this device draws the list, and asking a machine for it
 * would be wrong on a phone paired to three of them.
 */
import { observable } from "@legendapp/state";
import type { Session } from "@pounce/shared";
import { fetchSettled, setSettled as pushSettled } from "../services/bridge";
import { persist } from "../services/persistence";
import { AUTO_SETTLE_DEFAULT_DAYS, isSettled, type SettleOverrides } from "./settled";

export const settled$ = observable<SettleOverrides>({});

/**
 * Quiet days before a thread settles itself; null turns it off.
 *
 * On by default at T3 Code's three days, and that default matters more than it
 * looks: settle is an explicit gesture with no backfill, so a machine with a
 * year of history would open the inbox with every thread in it and no way to
 * reach a useful state except by hand-clearing hundreds. Measured on a real
 * machine: 228 threads, of which 29 had been touched in three days.
 */
export const autoSettleDays$ = observable<number | null>(AUTO_SETTLE_DEFAULT_DAYS);
persist(autoSettleDays$, "pounce.autoSettleDays");

/** The options every caller of the settle rule needs. Not memoized on purpose —
 *  `now` should be read at render, or a long-lived tab stops settling. */
export function settleOptions() {
  return { now: new Date().toISOString(), autoSettleAfterDays: autoSettleDays$.get() };
}

/** Re-read every paired machine's overrides. Safe to call repeatedly; a host
 *  that fails contributes nothing rather than clearing what we already knew. */
export async function loadSettled(): Promise<void> {
  try {
    settled$.set(await fetchSettled());
  } catch {
    // A failed read leaves the last known map in place: showing every thread as
    // un-settled because the network blinked would undo the user's work in the
    // one place they'd notice it most.
  }
}

/**
 * Flip a thread between settled and active.
 *
 * Writes the OPPOSITE of what the thread currently resolves to, rather than
 * toggling the stored value — with auto-settle on, most threads have no stored
 * value at all, and "un-settle" on one of those has to record an explicit
 * `active` or the inactivity rule settles it again on the same render.
 *
 * Applied locally first so the row moves under the cursor immediately; the
 * host's own map replaces ours on success, and a failed write puts the previous
 * value back.
 */
export async function toggleSettled(session: Session): Promise<void> {
  const id = session.id;
  const was = settled$[id].peek();
  const nowSettled = isSettled(session, was, settleOptions());
  const next = {
    state: nowSettled ? ("active" as const) : ("settled" as const),
    at: new Date().toISOString(),
  };

  settled$[id].set(next);
  try {
    settled$.set(await pushSettled(session.hostId, id, next.state, next.at));
  } catch {
    if (was) settled$[id].set(was);
    else settled$[id].delete();
  }
}
