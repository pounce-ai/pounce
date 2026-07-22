import type { ReactNode } from "react";
import type { StyleProp, ViewStyle } from "react-native";

/** A file dropped onto the app (desktop drag-and-drop). */
export interface DroppedFile {
  /** Absolute filesystem path. */
  path: string;
  name: string;
  /** MIME type when the OS reports one, "" otherwise (folders report none). */
  type: string;
}

export interface DropZoneProps {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Called with the dropped files/folders (absolute paths). */
  onDropFiles: (files: DroppedFile[]) => void;
}
