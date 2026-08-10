/**
 * The settled map, as the app holds it: `{ [threadId]: settledAt }`.
 *
 * Lives here rather than in a component so every surface reads one answer — the
 * desktop sidebar today, mobile's list next — and so a settle made on one
 * screen is visible on the other without a refetch.
 *
 * Deliberately NOT persisted locally. The bridge owns this (see
 * agents/settled.mjs): a local copy would be a second source of truth that
 * disagrees with the machine after any change made elsewhere, and the map is
 * small enough to re-read on connect.
 */
import { observable } from "@legendapp/state";
import type { Session } from "@pounce/shared";
import { fetchSettled, setSettled as pushSettled } from "../services/bridge";

export const settled$ = observable<Record<string, string>>({});

/** Re-read every paired machine's map. Safe to call repeatedly; a host that
 *  fails contributes nothing rather than clearing what we already knew. */
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
 * Settle a thread, or un-settle one that already is.
 *
 * Applied locally FIRST so the row moves under the cursor immediately — this is
 * a list-management gesture and a round trip's worth of lag makes it feel
 * broken. The host's own map replaces ours on success (it is the authority);
 * on failure the previous value is put back, so a dropped write never leaves
 * the list claiming something the machine doesn't believe.
 */
export async function toggleSettled(session: Session): Promise<void> {
  const id = session.id;
  const was = settled$[id].peek();
  const next = was ? null : new Date().toISOString();

  if (next) settled$[id].set(next);
  else settled$[id].delete();

  try {
    settled$.set(await pushSettled(session.hostId, id, next));
  } catch {
    if (was) settled$[id].set(was);
    else settled$[id].delete();
  }
}
