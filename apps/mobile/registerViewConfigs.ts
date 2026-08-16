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
 * NATIVE ONLY: these deep imports pull the real react-native in beside
 * react-native-web (see metro.config.js). Web never loads this — boot.web.ts
 * replaces the whole boot sequence.
 */
import "react-native/Libraries/Text/TextNativeComponent";
import "react-native/Libraries/Components/View/ViewNativeComponent";
