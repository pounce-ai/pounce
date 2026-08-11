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
