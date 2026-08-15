/**
 * Composer input seam — web implementation.
 *
 * react-native-enriched-markdown's web entry ships the RENDERER
 * (EnrichedMarkdownText) but not the editor: EnrichedMarkdownTextInput is
 * simply absent from index.web.tsx, so the mobile seam's import resolves to
 * undefined and the first interactive thread dies on React #130 ("Element type
 * is invalid") the moment the Composer mounts. Same gap as desktop, same
 * answer (see enrichedInput.desktop.tsx): compose in a plain TextInput and
 * treat the draft as raw markdown — onChangeMarkdown mirrors onChangeText, and
 * the imperative surface the Composer uses (setValue / focus / blur) hangs off
 * the forwarded ref.
 *
 * Enter sends; Shift-Enter inserts a newline. Unlike the desktop shim there is
 * no keyDownEvents contortion here — react-native-web's TextInput delivers real
 * DOM keyboard events through onKeyPress, and e.preventDefault() is enough to
 * keep the newline out of the draft when Enter submits.
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
    /** Hardware Enter (no modifiers) sends — same affordance as desktop. */
    onSubmitKey?: () => void;
    /** Native-engine styling — unused by the plain-text fallback. */
    markdownStyle?: unknown;
    style?: StyleProp<TextStyle>;
  }
>(function EnrichedMarkdownTextInputWeb(
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
      {...(onSubmitKey
        ? {
            // react-native-web forwards the DOM KeyboardEvent here, so the
            // modifier check and preventDefault are the whole story.
            onKeyPress: (e: {
              nativeEvent?: { key?: string; shiftKey?: boolean };
              preventDefault?: () => void;
            }) => {
              const n = e?.nativeEvent;
              if (n?.key === "Enter" && !n.shiftKey) {
                e.preventDefault?.();
                onSubmitKey();
              }
            },
          }
        : null)}
    />
  );
});
