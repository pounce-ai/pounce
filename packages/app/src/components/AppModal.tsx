/**
 * Modal seam. Mobile: React Native's native Modal. Desktop overrides this
 * per-platform (AppModal.desktop.tsx) because react-native-macos's native
 * modal host crashes the app — sheets render as an absolute-fill overlay
 * there instead.
 */
export { Modal } from "react-native";
