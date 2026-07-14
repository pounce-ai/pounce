import { useState } from "react";
import { Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { COLOR } from "../ui";
import type { DroppedFile, DropZoneProps } from "./DropZoneTypes";

export type { DroppedFile, DropZoneProps } from "./DropZoneTypes";

/** react-native-macos DragEvent payload (not in the shared RN types). */
interface MacDragEvent {
  nativeEvent: {
    dataTransfer?: {
      files?: { name: string; type: string | null; uri: string }[];
    };
  };
}

/** file:///Users/me/My%20File.txt → /Users/me/My File.txt */
function uriToPath(uri: string): string {
  return decodeURIComponent(uri.replace(/^file:\/\//, ""));
}

/**
 * macOS drag-and-drop target. Wraps the session pane; dragging files or
 * folders from Finder highlights the zone, dropping hands their absolute
 * paths to `onDropFiles`.
 */
export function DropZone({ children, className, onDropFiles }: DropZoneProps) {
  const [hovering, setHovering] = useState(false);

  const onDrop = (e: MacDragEvent) => {
    setHovering(false);
    const files: DroppedFile[] = (e.nativeEvent.dataTransfer?.files ?? [])
      .filter((f) => f.uri)
      .map((f) => {
        const path = uriToPath(f.uri);
        return {
          path,
          name: f.name || path.replace(/\/$/, "").split("/").pop() || path,
          type: f.type ?? "",
        };
      });
    if (files.length) onDropFiles(files);
  };

  // draggedTypes/onDrag* are macOS-only view props absent from the shared RN
  // typings this package typechecks against — pass them past the compiler.
  const dragProps = {
    draggedTypes: ["fileUrl"],
    onDragEnter: () => setHovering(true),
    onDragLeave: () => setHovering(false),
    onDrop,
  } as object;

  return (
    <View className={className} {...dragProps}>
      {children}
      {hovering ? (
        <View
          pointerEvents="none"
          className="absolute inset-0 items-center justify-center rounded-2xl border-2 border-dashed border-accent bg-bg/80"
        >
          <View className="items-center gap-2 rounded-2xl bg-bg-elevated px-6 py-5">
            <Ionicons name="attach" size={28} color={COLOR.accent} />
            <Text className="text-[15px] font-semibold text-fg">Drop to add to this chat</Text>
            <Text className="text-[12px] text-fg-muted">Files and folders become sources the agent can read</Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}
