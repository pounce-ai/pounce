/**
 * Loading bones for the sidebar's two lists.
 *
 * The shape has to match what replaces it or the swap reads as a jump: a Space
 * is a single 28pt line (dot · folder · name), a Session is three stacked lines
 * (project · host / title / agent · branch). The generic card skeleton in
 * @pounce/app was built for mobile's card list and looked nothing like either.
 */
import { useState } from "react";
import { StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { BONE } from "@pounce/app/components/Skeleton";
import { Shimmer } from "./Motion";

/** The shimmer needs a pixel width to travel across, and the sidebar is
 *  user-resizable — so measure rather than assume. */
function useMeasuredWidth(): [number, (e: LayoutChangeEvent) => void] {
  const [width, setWidth] = useState(0);
  return [width, (e) => setWidth(e.nativeEvent.layout.width)];
}

/** Deterministic width jitter so rows don't look rubber-stamped. Indexed
 *  rather than random: a re-render must not reshuffle the bones. */
const TITLE_WIDTHS = ["78%", "62%", "88%", "54%", "70%", "82%"] as const;
const CAPTION_WIDTHS = ["38%", "46%", "32%", "42%", "36%", "44%"] as const;
const BRANCH_WIDTHS = ["52%", "40%", "64%", "34%", "58%", "46%"] as const;
const SPACE_WIDTHS = ["58%", "44%", "66%", "50%", "38%", "60%"] as const;

export function SidebarSpacesSkeleton({ count = 4 }: { count?: number }) {
  const [width, onLayout] = useMeasuredWidth();
  return (
    <View style={s.sweepHost} onLayout={onLayout} pointerEvents="none">
      {Array.from({ length: count }).map((_, i) => (
        <View key={i} style={s.spaceRow}>
          <View style={s.dot} />
          <View style={s.glyph} />
          <View style={[s.line, { width: SPACE_WIDTHS[i % SPACE_WIDTHS.length] }]} />
        </View>
      ))}
      {width > 0 ? <Shimmer width={width} /> : null}
    </View>
  );
}

export function SidebarSessionsSkeleton({ count = 6 }: { count?: number }) {
  const [width, onLayout] = useMeasuredWidth();
  return (
    <View style={s.sweepHost} onLayout={onLayout} pointerEvents="none">
      {Array.from({ length: count }).map((_, i) => (
        <View key={i} style={s.sessionRow}>
          <View style={s.captionRow}>
            <View style={[s.caption, { width: CAPTION_WIDTHS[i % CAPTION_WIDTHS.length] }]} />
            <View style={s.time} />
          </View>
          <View style={[s.title, { width: TITLE_WIDTHS[i % TITLE_WIDTHS.length] }]} />
          <View style={s.metaRow}>
            <View style={s.dot} />
            <View style={[s.caption, { width: BRANCH_WIDTHS[i % BRANCH_WIDTHS.length] }]} />
          </View>
        </View>
      ))}
      {width > 0 ? <Shimmer width={width} /> : null}
    </View>
  );
}

const s = StyleSheet.create({
  // Clips the sweeping band to the block it belongs to.
  sweepHost: { overflow: "hidden" },
  // Mirrors Sidebar's spaceRow.
  spaceRow: {
    marginHorizontal: 6,
    height: 28,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingHorizontal: 8,
  },
  dot: { height: 6, width: 6, borderRadius: 999, backgroundColor: BONE },
  glyph: { height: 12, width: 12, borderRadius: 3, backgroundColor: BONE },
  line: { height: 9, borderRadius: 999, backgroundColor: BONE },

  // Mirrors Sidebar's sessionRow.
  sessionRow: {
    marginHorizontal: 6,
    marginBottom: 1,
    borderRadius: 7,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  captionRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  caption: { height: 7, borderRadius: 999, backgroundColor: BONE },
  time: { marginLeft: "auto", height: 7, width: 22, borderRadius: 999, backgroundColor: BONE },
  title: { marginTop: 5, height: 10, borderRadius: 999, backgroundColor: BONE },
  metaRow: { marginTop: 6, flexDirection: "row", alignItems: "center", gap: 5 },
});
