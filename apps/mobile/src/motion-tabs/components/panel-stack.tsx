import {
  type ComponentProps,
  type FC,
  type FunctionComponent,
  type JSX,
  memo,
  type ReactElement,
  type ReactNode,
} from "react";
import { View } from "react-native";

import type { IPanelStackProps } from "../typings/motion-tabs";
import { layoutStyles as styles } from "../utils/layout-styles";
import { PanelLayer } from "./panel-layer";

const PanelStack: FC<IPanelStackProps> & FunctionComponent<IPanelStackProps> =
  memo<IPanelStackProps & ComponentProps<typeof PanelStack>>(
    ({
      close,
      colors,
      direction,
      items,
      onMeasure,
      renderPopupBody,
      view,
    }: IPanelStackProps & ComponentProps<typeof PanelStack>):
      | (ReactNode & ReactElement & JSX.Element)
      | null => {
      return (
        <View style={styles.panelArea}>
          {items.map((item) => (
            <PanelLayer
              key={item.key}
              active={view === item.key}
              close={close}
              colors={colors}
              direction={direction}
              onLayout={onMeasure}
              renderPopupBody={renderPopupBody}
              route={item.route}
              view={item.key}
            />
          ))}
        </View>
      );
    },
  );

export { PanelStack };
