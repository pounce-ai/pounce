/**
 * What a session IS, as pure predicates over plain data.
 *
 * Split out of ./stores so they can be imported without dragging in the
 * persistence layer with them — stores.ts reaches MMKV and the react-db
 * collections at module scope, which makes anything importing it unusable from
 * a plain unit test. These rules are the most safety-critical thing in the
 * state layer (they decide what the inbox is allowed to hide), so they have to
 * be reachable without a device attached.
 *
 * ./stores re-exports every one of these, so existing call sites are unchanged.
 */
import type { Session } from "@pounce/shared";

/** Dotfolders (e.g. .deepsec) are treated as hidden — never surfaced anywhere. */
export const isDotName = (name: string): boolean => name.startsWith(".");

/** A session that wants the user's attention (failed / awaiting input). */
export const needsYou = (s: Session): boolean =>
  s.needsAttention || s.activity === "failed" || s.activity === "awaiting_input";

/** Sort rank for a session list: attention → active → live → done. */
export function rankSession(s: Session): number {
  if (needsYou(s)) return 0;
  if (s.activity === "running" || s.activity === "streaming") return 1;
  if (s.isLive) return 2;
  return 3;
}

/**
 * The three buckets every thread falls into, exactly one each.
 *
 * DISJOINT is the whole design. These used to be a two-way switch — "Needs you"
 * vs "Everything" — where the first was a SUBSET of the second, so the two could
 * never be on together and picking one always meant losing the other. Splitting
 * "active" to mean "live, but not waiting on you" makes the three a partition,
 * and a partition is something you can multi-select: each chip adds its own
 * slice and nothing overlaps.
 *
 *   needs   — blocked on you: a question, a failure, a turn that stopped
 *   active  — everything else that is live
 *   settled — the archive, filed by hand or by the quiet-days rule
 */
export type ShowBucket = "needs" | "active" | "settled";

/**
 * Both live buckets on, the archive off.
 *
 * The archive is off by DEFAULT and not by accident: a machine with a year of
 * history carries hundreds of settled threads against a couple of dozen live
 * ones, so including them would bury the work you opened the app for under the
 * work you already finished.
 */
export const DEFAULT_SHOW: readonly ShowBucket[] = ["needs", "active"];

/**
 * Which bucket a thread is in.
 *
 * `settled` is passed in rather than computed, because that rule needs the
 * override map and a clock (see ./settled) — everything else is a property of
 * the thread itself. Settledness is checked FIRST so this agrees with
 * `partitionSettled` by construction: that function already refuses to settle
 * anything blocked on you, so a thread can never be both filed away and
 * reported as needing you.
 */
export function showBucket(s: Session, settled: boolean): ShowBucket {
  return settled ? "settled" : needsYou(s) ? "needs" : "active";
}

/** Whether the Show buckets differ from the default pair — the one filter whose
 *  "off" state is a non-empty set, so it can't be tested for emptiness. */
export function showNarrowed(show: readonly ShowBucket[]): boolean {
  return show.length !== DEFAULT_SHOW.length || !DEFAULT_SHOW.every((b) => show.includes(b));
}
