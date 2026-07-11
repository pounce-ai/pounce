/**
 * Animation seam. Mobile: react-native-reanimated (worklets, layout
 * animations). Desktop overrides this per-platform with a static shim — see
 * animation.desktop.tsx — because Reanimated 4 requires the New Architecture,
 * which this project doesn't enable on react-native-macos/windows.
 */
export { default } from "react-native-reanimated";
export {
  default as Animated,
  FadeIn,
  FadeOut,
  LinearTransition,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
