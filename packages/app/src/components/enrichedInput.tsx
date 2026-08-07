/**
 * Composer input seam. Mobile: the native markdown editor from
 * react-native-enriched-markdown. Desktop overrides this per-platform with a
 * plain TextInput shim (see enrichedInput.desktop.tsx) because the native
 * component has no macOS/Windows build.
 *
 * The mobile editor is wrapped rather than re-exported so both sides accept the
 * same props: `onSubmitKey` is a desktop-only affordance (a hardware Enter
 * sends the message) and is swallowed here — a phone keyboard's return key
 * inserts a newline, and the component forwards unknown props straight to its
 * native view, which must not see one.
 */
import { EnrichedMarkdownTextInput as Native } from "react-native-enriched-markdown";
import type { ComponentProps } from "react";

export type {
  EnrichedMarkdownTextInputInstance,
  MarkdownTextInputStyle,
} from "react-native-enriched-markdown";

export function EnrichedMarkdownTextInput({
  onSubmitKey: _onSubmitKey,
  ...props
}: ComponentProps<typeof Native> & { onSubmitKey?: () => void }) {
  return <Native {...props} />;
}
