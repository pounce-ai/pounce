/** Keyboard-avoiding seam (iOS): react-native-keyboard-controller's drop-in
 *  KeyboardAvoidingView — tracks the keyboard on the UI thread. Wrapped with
 *  withUnistyles for the same reason as kav.android.ts: unistyles style
 *  objects must be resolved to plain styles before reaching the
 *  Reanimated-animated view. */
import { KeyboardAvoidingView as KCKeyboardAvoidingView } from "react-native-keyboard-controller";
import { withUnistyles } from "react-native-unistyles";

export const KeyboardAvoidingView = withUnistyles(KCKeyboardAvoidingView);
