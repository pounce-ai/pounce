import {
  memo,
  type ComponentProps,
  type FC,
  type FunctionComponent,
  type JSX,
  type ReactElement,
  type ReactNode,
} from "react";
import { View, type LayoutChangeEvent } from "react-native";

import type { IMeasurementLayerProps } from "../typings/motion-tabs";
import { layoutStyles as styles } from "../utils/layout-styles";

const NOOP = (): void => {};

const MeasurementLayer: FC<IMeasurementLayerProps> &
  FunctionComponent<IMeasurementLayerProps> = memo<
  IMeasurementLayerProps & ComponentProps<typeof MeasurementLayer>
>(
  ({
    colors,
    items,
    onMeasure,
    renderPopupBody,
  }: IMeasurementLayerProps & ComponentProps<typeof MeasurementLayer>):
    | (ReactNode & ReactElement & JSX.Element)
    | null => {
    const PopupBody = renderPopupBody;

    return (
      <View pointerEvents="none" style={styles.measure}>
        {items.map((item) => (
          <View
            key={item.key}
            onLayout={(event: LayoutChangeEvent) => {
              const { width, height } = event.nativeEvent.layout;
              onMeasure(item.key, Math.ceil(width), Math.ceil(height));
            }}
          >
            <PopupBody colors={colors} route={item.route} view={item.key} close={NOOP} />
          </View>
        ))}
      </View>
    );
  },
);

export { MeasurementLayer };
