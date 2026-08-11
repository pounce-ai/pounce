import { useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Ionicons } from "@expo/vector-icons";
import { useColors } from "../ui/tokens";
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
export function DropZone({ children, style, onDropFiles }: DropZoneProps) {
  const COLOR = useColors();
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
    <View style={style} {...dragProps}>
      {children}
      {hovering ? (
        <View pointerEvents="none" style={s.overlay}>
          <View style={s.card}>
            <Ionicons name="attach" size={28} color={COLOR.accent} />
            <Text style={s.title}>Drop to add to this chat</Text>
            <Text style={s.body}>Files and folders become sources the agent can read</Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create((theme) => ({
  overlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 16,
    borderWidth: 2,
    borderStyle: "dashed",
    borderColor: theme.colors.accent,
    // was bg at 80% — the semantic scrim token is the closest adaptive match.
    backgroundColor: theme.colors.overlay,
  },
  card: {
    alignItems: "center",
    gap: 8,
    borderRadius: 16,
    backgroundColor: theme.colors.bgElevated,
    paddingHorizontal: 24,
    paddingVertical: 20,
  },
  title: { fontSize: 15, fontWeight: "600", color: theme.colors.fg },
  body: { fontSize: 12, color: theme.colors.fgMuted },
}));
