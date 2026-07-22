/**
 * Unistyles runtime configuration — imported by the MOBILE entry
 * (apps/mobile/index.ts) before expo-router/entry so StyleSheet.configure
 * runs before any StyleSheet.create. The desktop bundle never imports this
 * file; it shims 'react-native-unistyles' wholesale in metro.config.js.
 *
 * adaptiveThemes starts ON (follow the OS scheme); the persisted appearance
 * override re-wires it via UnistylesRuntime in state/appearance.ts.
 */
import { StyleSheet } from "react-native-unistyles";
import { themes } from "./unistyles-themes";
import type { AppThemes } from "./unistyles-themes";

declare module "react-native-unistyles" {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  export interface UnistylesThemes extends AppThemes {}
}

StyleSheet.configure({
  themes,
  settings: {
    adaptiveThemes: true,
  },
});
