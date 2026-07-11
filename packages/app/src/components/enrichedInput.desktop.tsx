/**
 * Composer input seam — desktop implementation.
 *
 * react-native-enriched-markdown (a native Nitro component) has no
 * macOS/Windows build, so desktop composes in a plain TextInput: the draft is
 * treated as raw markdown (onChangeMarkdown mirrors onChangeText), and the
 * imperative surface the Composer uses (setValue / focus) is provided via the
 * forwarded ref. The macOS focus ring is disabled to match the app chrome.
 */
import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { TextInput, type StyleProp, type TextStyle } from "react-native";

export interface EnrichedMarkdownTextInputInstance {
  setValue(value: string): void;
  focus(): void;
  blur(): void;
}

/** Native-engine style map — accepted but unused by the plain-text fallback. */
export type MarkdownTextInputStyle = Record<string, unknown>;

export const EnrichedMarkdownTextInput = forwardRef<
  EnrichedMarkdownTextInputInstance,
  {
    onChangeText?: (text: string) => void;
    onChangeMarkdown?: (markdown: string) => void;
    editable?: boolean;
    placeholder?: string;
    placeholderTextColor?: string;
    multiline?: boolean;
    /** Native-engine styling — unused by the plain-text fallback. */
    markdownStyle?: unknown;
    style?: StyleProp<TextStyle>;
  }
>(function EnrichedMarkdownTextInputDesktop(
  { onChangeText, onChangeMarkdown, editable, placeholder, placeholderTextColor, multiline, style },
  ref,
) {
  const inputRef = useRef<TextInput>(null);
  const [value, setValue] = useState("");

  const emit = (text: string) => {
    setValue(text);
    onChangeText?.(text);
    onChangeMarkdown?.(text); // plain text IS the markdown on this path
  };

  useImperativeHandle(ref, () => ({
    setValue: emit,
    focus: () => inputRef.current?.focus(),
    blur: () => inputRef.current?.blur(),
  }));

  return (
    <TextInput
      ref={inputRef}
      value={value}
      onChangeText={emit}
      editable={editable}
      placeholder={placeholder}
      placeholderTextColor={placeholderTextColor}
      multiline={multiline}
      style={style}
      {...({ enableFocusRing: false } as Record<string, unknown>)}
    />
  );
});
