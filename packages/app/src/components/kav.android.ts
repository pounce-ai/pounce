/** Keyboard-avoiding seam (Android): react-native-keyboard-controller's
 *  drop-in KeyboardAvoidingView — tracks the keyboard on the UI thread.
 *  Wrapped with withUnistyles: call sites pass unistyles theme styles, and
 *  keyboard-controller's view is Reanimated-animated, which rejects the raw
 *  C++ style proxy ("an empty object is not a valid style value"). The HOC
 *  resolves style props to plain styles and re-renders on theme changes. */
import { KeyboardAvoidingView as KCKeyboardAvoidingView } from "react-native-keyboard-controller";
import { withUnistyles } from "react-native-unistyles";

export const KeyboardAvoidingView = withUnistyles(KCKeyboardAvoidingView);
