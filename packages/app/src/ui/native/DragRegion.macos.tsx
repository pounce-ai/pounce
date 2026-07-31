import { requireNativeComponent, UIManager, View, type ViewProps } from "react-native";

export { TITLEBAR_INSET, TRAFFIC_LIGHT_INSET } from "./titlebar";

// Guarded the same way as GlassSurface: an app binary built before the drag
// region existed has no view manager, and a plain View (no window dragging, but
// no redbox either) is the right degradation.
const NativeDragRegion =
  typeof UIManager.hasViewManagerConfig === "function" &&
  UIManager.hasViewManagerConfig("PounceDragRegionView")
    ? requireNativeComponent<ViewProps>("PounceDragRegionView")
    : null;

/**
 * macOS: a bare backdrop whose clicks drag the window.
 *
 * Render it as an `absoluteFill` sibling BEHIND a bar's controls, never as a
 * wrapper around them — it claims every click it receives, so anything painted
 * under it stops responding.
 */
export function DragRegion({ children, style, ...rest }: ViewProps) {
  const Host = NativeDragRegion ?? View;
  return (
    <Host style={style} {...rest}>
      {children}
    </Host>
  );
}
