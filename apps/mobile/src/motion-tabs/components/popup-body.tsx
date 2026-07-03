import type { FC, FunctionComponent } from "react";
import { View } from "react-native";
import type { IPopupRenderContext } from "../typings/motion-tabs";

/**
 * Default popup body — a no-op placeholder. The app always supplies its own
 * `renderPopupBody` (see src/components/TabPopups.tsx), so this fallback only
 * exists to keep the public API self-contained. Kept dependency-free on purpose.
 */
const PopupBody: FC<IPopupRenderContext> & FunctionComponent<IPopupRenderContext> = () => (
  <View style={{ width: 1, height: 1 }} />
);

export { PopupBody };
