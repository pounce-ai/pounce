import { useWindowDimensions, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { router } from "expo-router";
import { FilterSheetContent, SHEET_FRACTION } from "@pounce/app/components/FilterSheet";

/**
 * Filters as a TrueSheet screen (see the Sheet.Screen options in _layout).
 *
 * The explicit height is the whole trick, and it is why the detent is a fixed
 * fraction rather than 'auto':
 *
 *   • A native sheet measures its content view intrinsically, so `flex: 1` here
 *     resolves against nothing and collapses — the sheet renders as a bare Done
 *     button on an empty card.
 *   • With no height at all, the body scroller sizes to its own content and
 *     never scrolls; it overflows and the sheet clips it. That was the bug:
 *     every filter past the fold, and Done with it, was unreachable.
 *
 * Given a real number, the sheet is exactly as tall as it says it is, the body
 * flexes into it and scrolls, and the Done bar sits at the bottom of the
 * VIEWPORT rather than the bottom of the content. The bar's own bottom padding
 * absorbs any few points between this and the detent the system granted.
 */
export default function FiltersSheet() {
  const { height } = useWindowDimensions();
  return (
    <View style={[s.root, { height: Math.round(height * SHEET_FRACTION) }]}>
      <FilterSheetContent fill onClose={() => router.back()} />
    </View>
  );
}

const s = StyleSheet.create((theme) => ({
  root: {
    backgroundColor: theme.colors.bgElevated,
    paddingHorizontal: 16,
    paddingTop: 12,
    // Just a gap, NOT a safe-area inset: the sheet already insets itself for
    // the home indicator, and adding `rt.insets.bottom` on top left ~80pt of
    // dead card under the Done bar.
    paddingBottom: 12,
  },
}));
