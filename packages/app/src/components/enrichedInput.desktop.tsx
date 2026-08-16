/**
 * Composer input seam — desktop implementation: the shared plain-TextInput
 * fallback (see enrichedInputFallback.tsx) with desktop's key wiring. The
 * macOS focus ring is disabled to match the app chrome.
 *
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
import { Platform } from "react-native";
import { makeFallbackInput } from "./enrichedInputFallback";

export type {
  EnrichedMarkdownTextInputInstance,
  MarkdownTextInputStyle,
} from "./enrichedInputFallback";

const NO_MODIFIERS = { shiftKey: false, altKey: false, ctrlKey: false, metaKey: false };
const ENTER_KEY_DOWN =
  (Platform.OS as string) === "windows"
    ? [{ code: "Enter", ...NO_MODIFIERS }]
    : [{ key: "Enter", ...NO_MODIFIERS }];

export const EnrichedMarkdownTextInput = makeFallbackInput((onSubmitKey) => ({
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
}));
