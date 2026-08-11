/**
 * Unistyles runtime configuration — imported by the MOBILE entry
 * (apps/mobile/index.ts) before expo-router/entry, so configure() runs ahead of
 * any StyleSheet.create. Desktop shims the package wholesale instead.
 *
 * The initial theme is read straight out of MMKV rather than waiting for
 * state/appearance.ts to hydrate, which would show one frame of the default
 * palette before snapping to the picked one.
 */
import { StyleSheet } from "react-native-unistyles";
import { Appearance } from "react-native";
import { readPersisted } from "../services/persistence";
import { isThemeId, themeName, DEFAULT_THEME_ID } from "./palettes";
import { themes } from "./unistyles-themes";
import type { AppThemes } from "./unistyles-themes";

declare module "react-native-unistyles" {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  export interface UnistylesThemes extends AppThemes {}
}

function initialTheme(): keyof AppThemes {
  const mode = readPersisted("appearance");
  const scheme =
    mode === "light" || mode === "dark"
      ? mode
      : Appearance.getColorScheme() === "light"
        ? "light"
        : "dark";
  const id = readPersisted("theme");
  return themeName(isThemeId(id) ? id : DEFAULT_THEME_ID, scheme) as keyof AppThemes;
}

StyleSheet.configure({
  themes,
  settings: {
    adaptiveThemes: false,
    initialTheme: initialTheme(),
  },
});
