/**
 * A markdown editor for a whole document — the Space screen's CLAUDE.md pane.
 *
 * Deliberately built on `./enrichedInput` rather than importing
 * react-native-enriched-markdown directly. That seam already exists for the
 * Composer and already knows the platform truth: the phones get the native
 * markdown engine (typing `##` styles the heading as you go), desktop gets a
 * plain-text shim because the native component has no working macOS runtime.
 * Importing the package here instead would resolve to the real native module on
 * desktop and blank the app at boot — which is exactly what the seam is for.
 *
 * Seeding is done through the instance ref rather than a `value` prop: the
 * native input is uncontrolled and the desktop shim mirrors that contract, so
 * `setValue` on mount is the one path that behaves the same on both.
 */
import { useEffect, useRef } from "react";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { EnrichedMarkdownTextInput, type EnrichedMarkdownTextInputInstance } from "./enrichedInput";

export interface MarkdownEditorProps {
  /** Initial text, applied once on mount — remount with a `key` to swap files. */
  defaultValue: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  /** Floor for the box so a nearly-empty file still gives you room to type. */
  minHeight?: number;
}

export function MarkdownEditor({
  defaultValue,
  onChangeText,
  placeholder,
  autoFocus,
  minHeight = 320,
}: MarkdownEditorProps) {
  const { theme } = useUnistyles();
  const ref = useRef<EnrichedMarkdownTextInputInstance>(null);

  useEffect(() => {
    ref.current?.setValue(defaultValue);
    if (autoFocus) ref.current?.focus();
    // Mount only: this editor is uncontrolled, and re-seeding on every change
    // would fight the cursor. Callers remount to load a different file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <EnrichedMarkdownTextInput
      ref={ref}
      onChangeText={onChangeText}
      multiline
      placeholder={placeholder}
      placeholderTextColor={theme.colors.fgFaint as string}
      // No markdownStyle: the input's style map takes plain string colours, and
      // this app's theme colours are PlatformColor objects on iOS — they'd cross
      // to native as something it can't read. The package's own defaults handle
      // the inline emphasis; the container styling below is ordinary RN style,
      // where a PlatformColor is fine.
      style={{ ...s.editor, minHeight }}
    />
  );
}

const s = StyleSheet.create((theme) => ({
  editor: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.surface,
    padding: 12,
    fontSize: 15,
    lineHeight: 22,
    color: theme.colors.fg,
    textAlignVertical: "top",
  },
}));
