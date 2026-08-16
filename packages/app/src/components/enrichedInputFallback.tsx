/**
 * The plain-TextInput composer fallback shared by every platform where
 * react-native-enriched-markdown has no editor (desktop: no macOS/Windows
 * build; web: the package's web entry ships only the renderer). The draft is
 * treated as raw markdown — onChangeMarkdown mirrors onChangeText — and the
 * imperative surface the Composer uses (setValue / focus / blur) hangs off the
 * forwarded ref. Platform files supply only their Enter-to-send wiring via
 * `submitProps` (the mechanisms genuinely differ — see each file).
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

export interface FallbackInputProps {
  onChangeText?: (text: string) => void;
  onChangeMarkdown?: (markdown: string) => void;
  editable?: boolean;
  placeholder?: string;
  placeholderTextColor?: string;
  multiline?: boolean;
  /** Hardware Enter (no modifiers) sends. */
  onSubmitKey?: () => void;
  /** Native-engine styling — unused by the plain-text fallback. */
  markdownStyle?: unknown;
  style?: StyleProp<TextStyle>;
}

export function makeFallbackInput(
  submitProps: (onSubmitKey: (() => void) | undefined) => Record<string, unknown>,
) {
  return forwardRef<EnrichedMarkdownTextInputInstance, FallbackInputProps>(
    function EnrichedMarkdownTextInputFallback(
      {
        onChangeText,
        onChangeMarkdown,
        editable,
        placeholder,
        placeholderTextColor,
        multiline,
        onSubmitKey,
        style,
      },
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
          {...submitProps(onSubmitKey)}
        />
      );
    },
  );
}
