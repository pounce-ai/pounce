/**
 * Draggable column divider, shared by the sidebar and the changes dock.
 *
 * The strip has to carry real width: react-native-macos ignores `hitSlop` on a
 * plain View, so a hairline divider would be a hairline-wide drag target. The
 * visible parts are the 1px rule and a small centred grab handle — the rest is
 * invisible grab area either side of it.
 */
import { useRef } from "react";
import { PanResponder, View, type ViewProps } from "react-native";
import { StyleSheet } from "react-native-unistyles";

export const SPLITTER_WIDTH = 14;

export function Splitter({
  onStart,
  onMove,
  style,
}: {
  /** Drag began — capture whatever width the caller is about to move from. */
  onStart: () => void;
  /** Horizontal travel since `onStart`, in points. */
  onMove: (dx: number) => void;
  /** Position it absolutely to straddle a seam instead of taking a column of
   *  its own — see the sidebar's use in Shell. */
  style?: ViewProps["style"];
}) {
  // The responder is built once, so it must reach the callbacks through refs
  // rather than closing over this render's props.
  const handlers = useRef({ onStart, onMove });
  handlers.current = { onStart, onMove };

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => handlers.current.onStart(),
      onPanResponderMove: (_e, g) => handlers.current.onMove(g.dx),
    }),
  ).current;

  return (
    <View style={[s.root, style]} {...responder.panHandlers}>
      <View style={s.rule} />
      <View style={s.handle} />
    </View>
  );
}

const s = StyleSheet.create((theme) => ({
  root: { width: SPLITTER_WIDTH, alignItems: "center", justifyContent: "center" },
  // Full-height hairline: the divider you actually see. Takes the shim's
  // hairline rather than a literal 1 — see the note in shims/unistyles.ts, the
  // two are not the same number on macOS.
  rule: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: StyleSheet.hairlineWidth,
    backgroundColor: theme.colors.border,
  },
  // The affordance — a short raised bar saying "this edge moves". Uses a text
  // grey, not a border colour: `borderStrong` is AppKit's gridColor, which is
  // almost invisible against a light window.
  handle: { height: 32, width: 4, borderRadius: 999, backgroundColor: theme.colors.fgFaint },
}));
