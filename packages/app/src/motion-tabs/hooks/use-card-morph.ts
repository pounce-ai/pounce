import { useEffect } from "react";
import {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import type { ICardMorphOptions } from "../typings/motion-tabs";
import { DURATION, EASING } from "../utils/constants";

function useCardMorph({
  sizes,
  toolbarH,
  toolbarMinW,
  toolbarW,
  view,
}: ICardMorphOptions) {
  const open = useSharedValue<number>(0);
  const cardW = useSharedValue<number>(0);
  const cardH = useSharedValue<number>(0);

  useEffect(() => {
    if (toolbarMinW === 0 || toolbarH === 0) return;
    const firstInit = cardW.value === 0;
    if (view === "default") {
      cardW.value =
        firstInit ? toolbarMinW : (
          withTiming(toolbarMinW, { duration: DURATION, easing: EASING })
        );
      cardH.value =
        firstInit ? toolbarH : (
          withTiming(toolbarH, { duration: DURATION, easing: EASING })
        );
      open.value =
        firstInit ? 0 : (
          withTiming(0, { duration: DURATION - 80, easing: EASING })
        );
      return;
    }

    const target = sizes[view];
    if (target && target.w > 0 && target.h > 0) {
      const targetW = Math.max(toolbarMinW, toolbarW, target.w);
      const targetH = toolbarH + target.h;
      cardW.value =
        firstInit ? targetW : (
          withTiming(targetW, { duration: DURATION, easing: EASING })
        );
      cardH.value =
        firstInit ? targetH : (
          withTiming(targetH, { duration: DURATION, easing: EASING })
        );
    }
    open.value = withTiming(1, { duration: DURATION, easing: EASING });
  }, [view, sizes, toolbarMinW, toolbarW, toolbarH, open, cardW, cardH]);

  const cardStyle = useAnimatedStyle(() => {
    const w = cardW.value;
    const h = cardH.value;
    if (w === 0 || h === 0) return {};
    return { width: w, height: h };
  });

  const dividerStyle = useAnimatedStyle(() => ({
    opacity: open.value,
  }));

  return { cardStyle, dividerStyle };
}

export { useCardMorph };
