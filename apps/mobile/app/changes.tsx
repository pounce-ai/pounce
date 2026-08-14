import { useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import ChangesScreen from "@pounce/app/screens/Changes";
import { SHEET_FRACTION, sheetContentHeight } from "@pounce/app/ui/layout";

/** Changes inside the root TrueSheet navigator (see _layout). The sheet's
 *  detent is a fixed fraction of the window, so give the content an explicit
 *  matching height — 'auto'/flex sizing can't measure the diff WebView.
 *
 *  The height has to be measured against the sheet's own maximum, not the raw
 *  window: a native sheet stops at the top safe area, so window * fraction runs
 *  the footer off the bottom of the screen. See sheetContentHeight. */
export default function ChangesSheet() {
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  return (
    <View style={{ height: sheetContentHeight(height, insets.top, SHEET_FRACTION) }}>
      <ChangesScreen />
    </View>
  );
}
