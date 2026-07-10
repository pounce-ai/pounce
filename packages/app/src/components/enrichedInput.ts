/**
 * Composer input seam. Mobile: the native markdown editor from
 * react-native-enriched-markdown. Desktop overrides this per-platform with a
 * plain TextInput shim (see enrichedInput.desktop.tsx) because the native
 * component has no macOS/Windows build.
 */
export {
  EnrichedMarkdownTextInput,
  type EnrichedMarkdownTextInputInstance,
  type MarkdownTextInputStyle,
} from "react-native-enriched-markdown";
