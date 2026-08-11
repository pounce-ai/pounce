/**
 * The outermost element of a screen that wants a collapsing large title.
 *
 * iOS ties the large title to the screen's FIRST CHILD SCROLL VIEW — the rule
 * SettingsScroll already documents, and the reason Settings collapsed while
 * Home and Activity didn't. Both wrapped their list in a `<View>`, which puts a
 * plain UIView between the screen and its scroll view; UIKit then has nothing
 * to track and the title sits there at full height forever.
 *
 * So on mobile this is a FRAGMENT: it adds no native view, leaving the scroll
 * view as the screen's first child. The background the wrapper used to paint
 * comes from the stack's `contentStyle`, and the top inset from the bar itself.
 *
 * Desktop has no native bar, so it keeps a real View — it still needs something
 * to paint the background and carry the safe-area inset.
 *
 * Anything rendered BESIDE the scroll view (an offscreen capture target, a
 * desktop-only sheet) must come after it, or it becomes the first child and the
 * collapse breaks again.
 */
import type { ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { IS_DESKTOP } from "../ui";

export function ScreenRoot({
  children,
  style,
}: {
  children: ReactNode;
  /** Desktop only — the mobile branch renders no view to style. */
  style?: StyleProp<ViewStyle>;
}) {
  if (!IS_DESKTOP) return <>{children}</>;
  return <View style={style}>{children}</View>;
}
