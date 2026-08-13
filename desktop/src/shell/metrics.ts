/** Shell layout constants shared between the panes (Shell owns the sidebar, the
 *  dock has to reason about it when it grows past the main pane). */

import { scaledWidth } from "@pounce/app/ui/layout";

export const SIDEBAR_DEFAULT_WIDTH = 264;
/** Narrow enough that session titles still get a useful line, wide enough that
 *  long branch names aren't all ellipsis. */
export const SIDEBAR_MIN_WIDTH = 190;
export const SIDEBAR_MAX_WIDTH = 460;

/** The transcript never shrinks below this — past it the conversation stops
 *  being readable. Drag the sidebar in if the diff needs more room than that. */
export const MIN_TRANSCRIPT_WIDTH = 380;

/** What the sidebar opens at, given the window it opens in. 264 flat was picked
 *  on a laptop and read as a sliver on a large display, where the same session
 *  titles it was cut to fit had 1900pt of window to sit in. A sixth or so of the
 *  window tracks that (≈272 at 1512, ≈346 at 1920) without ever going under what
 *  a laptop already had or over what a drag is allowed to reach. Only ever the
 *  STARTING width — a drag settles it for good, see Shell. */
export const sidebarWidthFor = (shellWidth: number) =>
  scaledWidth(shellWidth, {
    fraction: 0.18,
    min: SIDEBAR_DEFAULT_WIDTH,
    max: SIDEBAR_MAX_WIDTH,
  });
