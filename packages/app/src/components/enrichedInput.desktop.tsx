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
import { Platform, TextInput, type StyleProp, type TextStyle } from "react-native";

export interface EnrichedMarkdownTextInputInstance {
  setValue(value: string): void;
  focus(): void;
  blur(): void;
}

/** Native-engine style map — accepted but unused by the plain-text fallback. */
export type MarkdownTextInputStyle = Record<string, unknown>;

/**
 * Enter sends; Shift-Enter (and any other modifier) still inserts a newline.
 *
 * This has to be done with `keyDownEvents` rather than `submitBehavior`/
 * `onSubmitEditing`: on a multiline field the macOS text view runs
 * `[super keyDown:]` BEFORE it emits the submit event, so the return key
 * inserts its newline and *then* submits. Listing the key in `keyDownEvents`
 * suppresses the native handling entirely and routes the press to JS instead.
 *
 * EVERY modifier is spelled out, and that is load-bearing. Under Fabric an
 * omitted modifier is `std::nullopt`, which `operator==(KeyEvent, HandledKey)`
 * reads as "don't care" — so a bare `{key: "Enter"}` also swallowed Shift-Enter
 * and the composer lost newlines entirely (measured, not guessed). The Paper
 * path's `RCTHandledKey` defaults them to NO instead, so writing them out is
 * the one spelling both renderers agree on.
 *
 * macOS matches the key by `key`, Windows by `code`. The `as string` is because
 * this package is typed against mobile react-native, whose Platform.OS union
 * has neither desktop member.
 */
const NO_MODIFIERS = { shiftKey: false, altKey: false, ctrlKey: false, metaKey: false };
const ENTER_KEY_DOWN =
  (Platform.OS as string) === "windows"
    ? [{ code: "Enter", ...NO_MODIFIERS }]
    : [{ key: "Enter", ...NO_MODIFIERS }];

export const EnrichedMarkdownTextInput = forwardRef<
  EnrichedMarkdownTextInputInstance,
  {
    onChangeText?: (text: string) => void;
    onChangeMarkdown?: (markdown: string) => void;
    editable?: boolean;
    placeholder?: string;
    placeholderTextColor?: string;
    multiline?: boolean;
    /** Hardware Enter (no modifiers) — desktop only; see ENTER_KEY_DOWN. */
    onSubmitKey?: () => void;
    /** Native-engine styling — unused by the plain-text fallback. */
    markdownStyle?: unknown;
    style?: StyleProp<TextStyle>;
  }
>(function EnrichedMarkdownTextInputDesktop(
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
      {...({
        enableFocusRing: false,
        ...(onSubmitKey
          ? {
              keyDownEvents: ENTER_KEY_DOWN,
              // Fires for every key; ENTER_KEY_DOWN only decides which ones the
              // text view stops handling itself, so re-check here.
              onKeyDown: (e: { nativeEvent?: { key?: string; shiftKey?: boolean } }) => {
                const n = e?.nativeEvent;
                if (n?.key === "Enter" && !n.shiftKey) onSubmitKey();
              },
            }
          : null),
      } as Record<string, unknown>)}
    />
  );
});
