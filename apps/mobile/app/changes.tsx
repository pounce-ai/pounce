import { useWindowDimensions, View } from "react-native";
import ChangesScreen from "@pounce/app/screens/Changes";

/** Changes inside the root TrueSheet navigator (see _layout). The sheet's
 *  detent is a fixed fraction of the window, so give the content an explicit
 *  matching height — 'auto'/flex sizing can't measure the diff WebView. */
export default function ChangesSheet() {
  const { height } = useWindowDimensions();
  return (
    <View style={{ height: height * 0.99 }}>
      <ChangesScreen />
    </View>
  );
}
