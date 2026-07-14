import { View } from "react-native";
import type { DropZoneProps } from "./DropZoneTypes";

export type { DroppedFile, DropZoneProps } from "./DropZoneTypes";

/**
 * Drag-and-drop target seam. Mobile has no OS drag-and-drop — this base
 * implementation just renders its children; DropZone.macos.tsx overlays the
 * real NSDraggingDestination-backed zone.
 */
export function DropZone({ children, className }: DropZoneProps) {
  return <View className={className}>{children}</View>;
}
