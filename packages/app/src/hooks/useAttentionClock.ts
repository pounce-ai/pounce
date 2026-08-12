/**
 * Re-renders a session list exactly when a thread finishes serving out
 * `ATTENTION_GRACE_MS`.
 *
 * `needsYou` reads the wall clock, so its answer changes with no state change
 * behind it — a thread that went quiet ten seconds ago should now be in the
 * attention shelf, but nothing has told React to look. This closes that.
 *
 * It schedules ONE timer for the earliest moment any pending thread crosses the
 * line, rather than polling every second. Most of the time nothing is pending
 * and no timer exists at all; when several threads are waiting, the first to
 * come due wakes the list and the effect re-runs to schedule the next.
 *
 * The returned value is only useful as a `useMemo` dependency — it is a
 * revision counter, not a clock you should compute with. Compute with
 * `needsYou`/`needsYouAt` so every call site agrees on the rule.
 */
import { useEffect, useState } from "react";
import type { Session } from "@pounce/shared";
import { ATTENTION_GRACE_MS } from "../state/sessionRules";

/** Mirrors `inAttentionState` in ../state/sessionRules, which is private there:
 *  this asks "would the grace period apply?", not "does it need you?". */
function pending(s: Session): boolean {
  return s.needsAttention || s.activity === "failed" || s.activity === "awaiting_input";
}

export function useAttentionClock(sessions: readonly Session[]): number {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const now = Date.now();
    let soonest = Infinity;
    for (const s of sessions) {
      if (!pending(s)) continue;
      const since = Date.parse(s.updatedAt);
      if (Number.isNaN(since)) continue;
      const due = since + ATTENTION_GRACE_MS;
      // Already served its time — it is in the shelf, nothing to wait for.
      if (due <= now) continue;
      if (due < soonest) soonest = due;
    }
    if (!Number.isFinite(soonest)) return;
    // A floor keeps a pathological clock (or a timestamp a millisecond away)
    // from spinning this into a tight re-render loop.
    const id = setTimeout(() => setTick((n) => n + 1), Math.max(250, soonest - now));
    return () => clearTimeout(id);
  }, [sessions, tick]);

  return tick;
}
