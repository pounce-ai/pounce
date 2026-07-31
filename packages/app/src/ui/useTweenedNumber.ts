import { useEffect, useRef, useState } from "react";

/**
 * Ease a number from its previous value to a new one, so a stat that changes
 * reads as the same figure moving rather than one number being swapped for
 * another. Switching the dashboard's period is the case this exists for: four
 * tiles all re-render at once, and a hard cut makes the card feel mechanical.
 *
 * Tweened in JS on rAF rather than with Animated, because the output is TEXT —
 * the value has to pass through a formatter ("17.8B", "~$7,838") every frame,
 * which a native-driven Animated.Value can't do.
 *
 * The FIRST value is never animated. Counting up from zero on load would make
 * every mount a slot machine, and would misreport the number while it ran.
 */
export function useTweenedNumber(target: number, durationMs = 420): number {
  const [shown, setShown] = useState(target);
  const from = useRef(target);
  const frame = useRef<number | null>(null);
  const mounted = useRef(false);

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      from.current = target;
      setShown(target);
      return;
    }
    const start = from.current;
    if (start === target || !Number.isFinite(target) || !Number.isFinite(start)) {
      from.current = target;
      setShown(target);
      return;
    }
    let t0: number | null = null;
    const step = (now: number) => {
      if (t0 == null) t0 = now;
      const p = Math.min(1, (now - t0) / durationMs);
      // easeOutCubic: quick off the mark, settles gently onto the final value.
      const eased = 1 - Math.pow(1 - p, 3);
      setShown(start + (target - start) * eased);
      if (p < 1) frame.current = requestAnimationFrame(step);
      else from.current = target;
    };
    frame.current = requestAnimationFrame(step);
    return () => {
      if (frame.current != null) cancelAnimationFrame(frame.current);
      // Land on the target if we're torn down mid-flight, so the tile can never
      // be left showing an intermediate number.
      from.current = target;
    };
  }, [target, durationMs]);

  return shown;
}
