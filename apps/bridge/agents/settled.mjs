/**
 * Settled threads — the user saying "I'm done with this one."
 *
 * The sidebar is an inbox rather than a folder tree: finished work is cleared
 * out of the active list instead of accumulating in it. This is the store
 * behind that gesture.
 *
 * BRIDGE-OWNED, for the reason ./markers.mjs already records: state kept only
 * in the app's MMKV is invisible to every other device, so settling on the
 * phone would leave the desktop showing the same thread as active. The bridge
 * already knows every thread on the machine, so it owns this too.
 *
 * Plain JSON rather than markers' SQLite: this is at most ONE row per thread
 * (hundreds), not one per message (thousands), so it needs no query planner and
 * no schema migration — see ./store.mjs for why that store exists at all.
 *
 * Rows for threads that no longer exist are inert — the map is keyed by thread
 * id, so a vanished thread simply never matches — and there is no delete path
 * to hook a cleanup onto today. If this ever needs pruning it is one pass over
 * the known thread ids, added here.
 *
 * What is stored is a DIRECTION AND A MOMENT, never a plain boolean. "The user
 * said X as of this time" is what makes auto-unsettle free: the app compares
 * `at` against the thread's own `updatedAt`, so any turn, message or status
 * change after the fact overtakes the override and the thread falls back to the
 * automatic rule. Nothing has to watch for activity and nothing can go stale —
 * see `isSettled` in packages/app/src/state/settled.ts.
 */
import { Store } from "./store.mjs";

const store = new Store("settled");
const now = () => new Date().toISOString();

/** `{ [threadId]: { state, at } }` — every thread the user has an opinion on. */
export function listSettled() {
  const out = {};
  for (const [threadId, row] of Object.entries(store.all())) {
    if (row?.at && (row.state === "settled" || row.state === "active")) {
      out[threadId] = { state: row.state, at: row.at };
    }
  }
  return out;
}

/**
 * Record what the user said about a thread, or clear it with `state: null`.
 *
 * BOTH directions are storable. "active" is not the absence of a settle: once
 * threads settle themselves after N quiet days, "keep this one out" is a thing
 * the user has to be able to say, and clearing the row would just let the
 * inactivity rule settle it again.
 *
 * `at` is a parameter because the CALLER's clock is the one the user acted on,
 * and it has to be comparable with the thread's `updatedAt`: stamping server
 * time here would let a phone settle a thread a moment "before" its own last
 * message and have it spring straight back.
 */
export function setSettled(threadId, state, at = now()) {
  if (!threadId) return false;
  if (state == null) return store.delete(threadId);
  if (state !== "settled" && state !== "active") return false;
  const stamp = typeof at === "string" && !Number.isNaN(Date.parse(at)) ? at : now();
  store.set(threadId, { state, at: stamp, updatedAt: now() });
  return true;
}

/** Test seam. */
export const _store = store;
