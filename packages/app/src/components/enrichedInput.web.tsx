/**
 * Composer input seam — web. The shared plain-TextInput fallback (see
 * enrichedInputFallback.tsx) with Enter-to-send via react-native-web's real
 * DOM keyboard events: preventDefault is enough to keep the newline out when
 * Enter submits, no keyDownEvents contortion needed (that's a desktop-native
 * mechanism — see enrichedInput.desktop.tsx).
 */
import { makeFallbackInput } from "./enrichedInputFallback";

export type {
  EnrichedMarkdownTextInputInstance,
  MarkdownTextInputStyle,
} from "./enrichedInputFallback";

export const EnrichedMarkdownTextInput = makeFallbackInput((onSubmitKey) =>
  onSubmitKey
    ? {
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
    : {},
);
