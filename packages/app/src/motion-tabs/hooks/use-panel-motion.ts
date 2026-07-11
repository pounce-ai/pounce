import { BlurView, type BlurViewProps } from "expo-blur";
import { useEffect } from "react";
import type { ViewStyle } from "react-native";
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { DURATION, EASING, PANEL_SLIDE } from "../utils/constants";

const AnimatedBlurView =
  Animated.createAnimatedComponent<typeof BlurView>(BlurView);

function usePanelMotion<T extends boolean, D extends number>(
  active: T,
  direction: D,
) {
  const progress = useSharedValue<number>(active ? 1 : 0);

  useEffect(() => {
    progress.value = withTiming<number>(active ? 1 : 0, {
      duration: DURATION - 80,
      easing: EASING,
    });
  }, [active, progress]);

  const style = useAnimatedStyle<
    Pick<ViewStyle, "opacity" | "transform">
  >(() => {
    const p = progress.value;
    const travel = direction === 0 ? 0 : direction * PANEL_SLIDE;
    const translateX = active ? travel * (1 - p) : -travel * (1 - p);
    return {
      opacity: p,
      transform: [{ translateX }, { scale: withSpring(0.97 + 0.03 * p) }],
    };
  }, [active, direction]);

  const blurProps = useAnimatedProps<Pick<BlurViewProps, "intensity">>(() => ({
    intensity: withSpring(
      interpolate(progress.value, [0, 0.5, 1], [0, 15, 0], Extrapolation.CLAMP),
    ),
  }));

  const androidBlurStyle = useAnimatedStyle<Pick<ViewStyle, "filter">>(() => ({
    filter: [
      {
        blur: withSpring(
          interpolate(
            progress.value,
            [0, 0.5, 1],
            [0, 10, 0],
            Extrapolation.CLAMP,
          ),
        ),
      },
    ],
  }));

  return { AnimatedBlurView, androidBlurStyle, blurProps, style };
}

export { usePanelMotion };
