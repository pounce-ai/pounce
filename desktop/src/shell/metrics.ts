/** Shell layout constants shared between the panes (Shell owns the sidebar, the
 *  dock has to reason about it when it grows past the main pane). */

export const SIDEBAR_DEFAULT_WIDTH = 264;
/** Narrow enough that session titles still get a useful line, wide enough that
 *  long branch names aren't all ellipsis. */
export const SIDEBAR_MIN_WIDTH = 190;
export const SIDEBAR_MAX_WIDTH = 460;

/** The transcript never shrinks below this — past it the conversation stops
 *  being readable. Drag the sidebar in if the diff needs more room than that. */
export const MIN_TRANSCRIPT_WIDTH = 380;
