import { useEffect, useRef, useState } from "react";

/**
 * Grok-style reveal pacing: the bridge streams text in sentence-sized chunks,
 * and splashing a whole chunk at once defeats the tail fade-in. This parcels
 * growth out a few words per tick instead — with an adaptive step so a big
 * chunk drains in under a second and the shown text never trails the real
 * stream far. Non-append updates (recycled row, rewritten buffer) and the
 * settled state pass through verbatim; the first mount does too, so reopening a
 * mid-stream thread doesn't replay the whole message.
 *
 * Shared by both MessageMarkdown implementations: the mobile renderer softens
 * each increment with a native tail fade, and on desktop the small steady steps
 * are themselves the effect (Reanimated is a no-op on that platform, so there
 * is no other motion to lean on).
 */
export function usePacedText(target: string, enabled: boolean): string {
  const [shown, setShown] = useState(target);
  const shownRef = useRef(target);
  useEffect(() => {
    if (!enabled || !target.startsWith(shownRef.current)) {
      shownRef.current = target;
      setShown(target);
      return;
    }
    if (target.length === shownRef.current.length) return;
    const timer = setInterval(() => {
      const cur = shownRef.current;
      if (cur.length >= target.length) {
        clearInterval(timer);
        return;
      }
      // A steady 1–2 words per tick is what makes the reveal read as calm.
      // Only a deep backlog (a burst chunk) drains faster, and even then gently.
      const backlog = target.length - cur.length;
      const steps = backlog > 600 ? 4 : backlog > 250 ? 2 : 1;
      let next = cur.length;
      for (let i = 0; i < steps && next < target.length; i++) {
        const ws = target.slice(next + 1).search(/\s/);
        next = ws === -1 ? target.length : next + 1 + ws;
      }
      shownRef.current = target.slice(0, next);
      setShown(shownRef.current);
    }, 40);
    return () => clearInterval(timer);
  }, [target, enabled]);
  return enabled ? shown : target;
}
