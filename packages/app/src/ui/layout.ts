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

/**
 * How tall a full-height sheet route's content may be.
 *
 * A TrueSheet detent is a fraction of the sheet's MAXIMUM height, and a native
 * sheet's maximum stops at the top safe area — UISheetPresentationController
 * will not present above the notch. `useWindowDimensions().height` is the whole
 * screen, notch included, so sizing content to `windowHeight * fraction` makes
 * it taller than the sheet it sits in by roughly the top inset.
 *
 * Nothing clamps that overflow: the content simply extends past the sheet's
 * bottom edge and off the screen, which is how Changes shipped with its commit
 * field and Commit/Push/Draft PR row sliced in half — on a 874pt iPhone screen
 * with a 59pt top inset, 58pt of the footer was below the visible sheet.
 *
 * Callers must pass the same `fraction` they gave the route's `detents`, which
 * is why SHEET_FRACTION exists rather than a literal at each site.
 */
export const SHEET_FRACTION = 0.99;

export function sheetContentHeight(
  windowHeight: number,
  topInset: number,
  fraction: number = SHEET_FRACTION,
): number {
  // Before the first layout both can be 0; a height of 0 is better than a
  // negative one, and the next render corrects it.
  const usable = Math.max(0, windowHeight - topInset);
  return Math.round(usable * fraction);
}
