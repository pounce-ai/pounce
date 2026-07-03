import {
  memo,
  type ComponentProps,
  type FC,
  type FunctionComponent,
  type JSX,
  type ReactElement,
  type ReactNode,
} from "react";
import { Platform, StyleSheet, type LayoutChangeEvent } from "react-native";
import Animated from "react-native-reanimated";
import { usePanelMotion } from "../hooks/use-panel-motion";
import type { IPanelLayerProps } from "../typings/motion-tabs";
import { layoutStyles as styles } from "../utils/layout-styles";

const PanelLayer: FC<IPanelLayerProps> & FunctionComponent<IPanelLayerProps> =
  memo<IPanelLayerProps & ComponentProps<typeof PanelLayer>>(
    ({
      active,
      close,
      colors,
      direction,
      onLayout,
      renderPopupBody,
      route,
      view,
    }: IPanelLayerProps & ComponentProps<typeof PanelLayer>):
      | (ReactNode & ReactElement & JSX.Element)
      | null => {
      const motion = usePanelMotion(active, direction);
      const PopupBody = renderPopupBody;

      return (
        <Animated.View
          pointerEvents={active ? "auto" : "none"}
          style={[styles.panelLayer, motion.style]}
        >
          <Animated.View
            onLayout={(event: LayoutChangeEvent) => {
              const { width, height } = event.nativeEvent.layout;
              onLayout(view, Math.ceil(width), Math.ceil(height));
            }}
            style={Platform.OS === "android" && motion.androidBlurStyle}
          >
            <PopupBody colors={colors} route={route} view={view} close={close} />
          </Animated.View>
          {Platform.OS === "ios" && (
            <motion.AnimatedBlurView
              animatedProps={motion.blurProps}
              pointerEvents="none"
              tint={"systemUltraThinMaterialDark"}
              style={StyleSheet.absoluteFill}
            />
          )}
        </Animated.View>
      );
    },
  );

export { PanelLayer };
