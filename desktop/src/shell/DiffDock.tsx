/**
 * The Changes pane, docked to the right of the transcript.
 *
 * Reviewing a diff is something you do *while* reading what the agent said, so
 * on desktop it sits beside the conversation instead of covering it (mobile
 * keeps the sheet — there's no room for two columns on a phone). The screen
 * itself is reused whole in `embedded` mode; only the framing lives here.
 *
 * Its divider drags, and dragging it narrow enough closes the pane rather than
 * bottoming out at an unreadably thin column. It never touches the sidebar:
 * when the diff needs more room than the transcript can spare, the sidebar's
 * own divider is there to give it.
 */
import { useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import ChangesScreen from "@pounce/app/screens/Changes";
import { T } from "@pounce/app/ui/theme";
import { nav$ } from "../shims/router";
import { Splitter, SPLITTER_WIDTH } from "./Splitter";
import { CrossFade } from "./Motion";

/** Below this the diff is too narrow to read, so the pane closes instead. */
export const DOCK_HIDE_BELOW = 300;
export const DOCK_DEFAULT_WIDTH = 460;

export function DiffDock({ threadId, maxWidth }: { threadId: string; maxWidth: number }) {
  const [width, setWidth] = useState(DOCK_DEFAULT_WIDTH);
  // Drags report travel since they began, so remember where they began.
  const widthRef = useRef(DOCK_DEFAULT_WIDTH);
  const startWidth = useRef(DOCK_DEFAULT_WIDTH);
  const maxRef = useRef(maxWidth);
  maxRef.current = maxWidth;

  const onMove = (dx: number) => {
    // Dragging left widens the pane — it's anchored to the right edge.
    const raw = startWidth.current - dx;
    if (raw < DOCK_HIDE_BELOW) {
      widthRef.current = DOCK_DEFAULT_WIDTH;
      nav$.dock.set(false);
      return;
    }
    const next = Math.min(maxRef.current, raw);
    widthRef.current = next;
    setWidth(next);
  };

  // A window (or sidebar) that grew could otherwise squeeze the transcript out.
  const clamped = Math.min(width, Math.max(DOCK_HIDE_BELOW, maxWidth));

  return (
    // The divider sits inside the dock's box, so add the strip back on — then
    // `width` means "how much diff you can see", not "column including gutter".
    <View style={[s.root, { width: clamped + SPLITTER_WIDTH }]}>
      <Splitter
        onStart={() => {
          startWidth.current = widthRef.current;
        }}
        onMove={onMove}
      />
      {/* Fade in with the shared CrossFade rather than a bespoke animation:
          this pane was hand-rolling a native-driven opacity+slide and, when it
          failed to start, the diff rendered at opacity 0 — a blank pane with no
          error. CrossFade is JS-driven and settles to fully visible if it's
          ever torn down, so a decorative fade can't hide the content.
          Keyed on the thread so switching tabs replays it, and so the screen
          remounts: it loads its diff from the id it mounted with, and a stale
          diff beside a new transcript is worse than a flash of loading. */}
      <CrossFade key={threadId} style={s.body}>
        <ChangesScreen embedded threadId={threadId} onClose={() => nav$.dock.set(false)} />
      </CrossFade>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flexDirection: "row", backgroundColor: T.bg },
  body: { flex: 1 },
});
