/** Window-chrome metrics, in their own module so both DragRegion platform
 *  files can re-export them (a `.macos.tsx` re-exporting from `./DragRegion`
 *  resolves back to itself). */

/** Points of top chrome the macOS traffic lights occupy: the buttons sit at
 *  ~y=12 with a 16pt diameter, so a top bar needs this much height before it
 *  can hold content of its own. */
export const TITLEBAR_INSET = 38;
/** Horizontal clearance for the three buttons themselves. */
export const TRAFFIC_LIGHT_INSET = 78;
