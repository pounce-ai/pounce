import { View, type ViewProps } from "react-native";

export { TITLEBAR_INSET, TRAFFIC_LIGHT_INSET } from "./titlebar";

/**
 * Cross-platform fallback: a plain View. The macOS platform file resolves to
 * the native NSView that drags the window (PounceGlass.mm) — the behaviour the
 * unified titlebar took away when the app started drawing its own top chrome.
 */
export function DragRegion({ children, style, ...rest }: ViewProps) {
  return (
    <View style={style} {...rest}>
      {children}
    </View>
  );
}
