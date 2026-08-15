/**
 * Register the RCTText/RCTVirtualText/RCTView view configs before first render.
 *
 * boost rewrites <Text>/<View> to NativeText/NativeView imports and the
 * unistyles plugin then swaps those for its Lean components, which render the
 * host components by NAME ('RCTText') — so nothing left in the bundle evaluates
 * the react-native modules that register those view configs. Dev boots anyway
 * (LogBox pulls in RN's Text early); release bundles crashed at the first
 * <Text> with "View config getter callback for component 'RCTText' must be a
 * function". Side-effect deep imports dodge both babel rewrites.
 *
 * Lives in its own module so web can opt out via registerViewConfigs.web.ts —
 * these are deep react-native imports, and on web they pull the real
 * react-native in beside react-native-web.
 */
import "react-native/Libraries/Text/TextNativeComponent";
import "react-native/Libraries/Components/View/ViewNativeComponent";
