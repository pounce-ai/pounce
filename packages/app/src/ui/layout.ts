/**
 * How wide a desktop column may grow as its window does.
 *
 * The bug being fixed: every column here was one fixed number picked on a
 * laptop, so a 1920pt display spent the extra 500pt on empty gutter rather than
 * on the content. A bare fraction is no better — uncapped, an ultrawide runs a
 * paragraph past the line length anyone can read, and a small window loses
 * width it has today. A fraction with both a floor and a ceiling is the only
 * shape that answers all three.
 */

export type WidthBounds = {
  /** Share of the available width to take before the caps apply. */
  fraction: number;
  /** Never narrower than this — it is what the fixed number used to give. */
  min: number;
  /** Never wider than this — past it the content stops being readable. */
  max: number;
};

/** `available` is 0 until the first layout, and a fraction of nothing would
 *  flash a column at its minimum before snapping wide; report the floor, which
 *  is the width the caller would have shipped anyway. */
export function scaledWidth(available: number, bounds: WidthBounds): number {
  if (!(available > 0)) return bounds.min;
  return Math.round(Math.min(bounds.max, Math.max(bounds.min, available * bounds.fraction)));
}
