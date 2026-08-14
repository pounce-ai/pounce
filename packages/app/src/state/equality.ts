/**
 * Structural equality for JSON-shaped values, and the hook that uses it to hold
 * a derived value's IDENTITY still.
 *
 * Both exist for the same reason. Anything derived from a collection is a fresh
 * object every time that collection ticks, even when the contents are identical
 * — which defeats memoization on whatever receives it, React Compiler included,
 * because the prop genuinely did change identity. Comparing one screen's worth
 * of data is far cheaper than the re-render it prevents.
 *
 * Deliberately free of React Native imports so it can be unit-tested without a
 * device runtime.
 */
import { useRef } from "react";

/** Structural equality for JSON-shaped values (primitives, plain objects,
 *  arrays). Bails to `false` on anything exotic — Date, Map, Set, class
 *  instances — rather than guessing, so an unrecognised shape is treated as
 *  changed and the caller behaves exactly as it did before. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true; // fast path: identical refs and equal primitives
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== "object") return false;
  const aArr = Array.isArray(a);
  if (aArr !== Array.isArray(b)) return false;
  if (aArr) {
    const x = a as unknown[];
    const y = b as unknown[];
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (!deepEqual(x[i], y[i])) return false;
    return true;
  }
  if (Object.getPrototypeOf(a) !== Object.prototype) return false;
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  const xk = Object.keys(x);
  if (xk.length !== Object.keys(y).length) return false;
  for (const k of xk) {
    if (!Object.hasOwn(y, k) || !deepEqual(x[k], y[k])) return false;
  }
  return true;
}

/**
 * Return the PREVIOUS value whenever the new one is equivalent to it.
 *
 * Note this hands back a stale-but-equal reference on purpose: the point is that
 * consumers memoized on identity stop seeing a change. Only use it for values
 * that are fully described by `isEqual` — if a component reads something the
 * comparison doesn't cover, it will miss that update.
 */
export function useStable<T>(next: T, isEqual: (a: T, b: T) => boolean = deepEqual): T {
  const ref = useRef<T>(next);
  if (ref.current !== next && !isEqual(ref.current, next)) ref.current = next;
  return ref.current;
}
