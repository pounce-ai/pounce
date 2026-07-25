/**
 * Context-window fill maths, kept apart from the ring that draws it so it can
 * be tested without a renderer (and reused if another surface wants the same
 * reading).
 *
 * This measures "how much room is left in this conversation" — NOT "how many
 * tokens has this thread cost". Those differ by orders of magnitude: a thread
 * can burn 60M tokens across hundreds of turns while every individual request
 * still fits comfortably inside a 1M window. The numerator is the size of the
 * most recent request, straight from the agent; the denominator is the window
 * the agent itself stated. Compaction shows up for free — the request after one
 * is smaller, so the reading drops.
 */
import type { ThreadUsage } from "../services/bridge";

export type FillLevel = "calm" | "warn" | "critical";

export interface ContextFill {
  /** 0–1, clamped — what the arc draws. */
  readonly pct: number;
  /** Whole-percent label; can exceed 100 when a thread is over its window. */
  readonly shown: number;
  readonly level: FillLevel;
  readonly used: number;
  readonly window: number;
}

/**
 * Decide whether there's a fill worth drawing, and at what severity.
 *
 * Returns null unless BOTH numbers are genuinely known. We never infer a window
 * from the model name: a 1M-context Opus and a 200K one report the same
 * canonical name, so guessing would quietly show 24% where the truth is 120%.
 */
export function contextFill(usage: ThreadUsage | null): ContextFill | null {
  const used = usage?.contextUsed;
  const window = usage?.contextWindow;
  if (!usage?.available || used == null || used < 0 || !window || window <= 0) return null;
  const ratio = used / window;
  // Clamp the arc, but let the label report the true figure so an over-window
  // thread doesn't silently look merely full.
  return {
    pct: Math.min(1, Math.max(0, ratio)),
    shown: Math.round(ratio * 100),
    level: ratio >= 0.85 ? "critical" : ratio >= 0.6 ? "warn" : "calm",
    used,
    window,
  };
}
