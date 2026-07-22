/** Keyboard-avoiding seam: desktop/default uses RN's JS-thread implementation;
 *  iOS/Android resolve kav.ios/.android — react-native-keyboard-controller's
 *  drop-in, which tracks the keyboard on the UI thread (frame-perfect lift,
 *  no JS round-trip; needs the KeyboardProvider mobile Providers mount). */
export { KeyboardAvoidingView } from "react-native";
