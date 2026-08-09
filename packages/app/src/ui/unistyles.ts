/**
 * Unistyles runtime configuration — imported by the MOBILE entry
 * (apps/mobile/index.ts) before expo-router/entry so StyleSheet.configure
 * runs before any StyleSheet.create. The desktop bundle never imports this
 * file; it shims 'react-native-unistyles' wholesale in metro.config.js.
 *
 * adaptiveThemes is OFF. It only understands themes literally named
 * light/dark, and a named theme registers as "<id>-<scheme>" — so
 * state/appearance.ts resolves the scheme itself and drives setTheme, and
 * listens for OS appearance changes in adaptive mode's place.
 *
 * The initial theme is read straight out of MMKV rather than waiting for
 * state/appearance.ts: that module hydrates a moment later, and a theme picked
 * on the last launch would otherwise show one frame of the system palette
 * before snapping to itself.
 */
import { StyleSheet } from "react-native-unistyles";
import { Appearance } from "react-native";
import { MMKV } from "react-native-mmkv";
import { storage } from "../services/persistence";
import { isThemeId, themeName, DEFAULT_THEME_ID } from "./palettes";
import { themes } from "./unistyles-themes";
import type { AppThemes } from "./unistyles-themes";

declare module "react-native-unistyles" {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  export interface UnistylesThemes extends AppThemes {}
}

/**
 * Legend State's MMKV plugin writes each observable as a JSON value under its
 * persist name — into its OWN store (`obsPersist`), not the app's, because
 * services/persistence.ts registers the plugin without an mmkv config. Read
 * that store first and the app's as a fallback, so this keeps working if the
 * persistence wiring changes; anything unexpected (fresh install, downgrade,
 * hand-edited store) falls back to the defaults below.
 */
let legendStore: MMKV | null = null;
function persisted(key: string): string | null {
  try {
    legendStore ??= new MMKV({ id: "obsPersist" });
    const raw = legendStore.getString(key) ?? storage.getString(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function initialTheme(): keyof AppThemes {
  const mode = persisted("appearance");
  const scheme =
    mode === "light" || mode === "dark"
      ? mode
      : Appearance.getColorScheme() === "light"
        ? "light"
        : "dark";
  const id = persisted("theme");
  return themeName(isThemeId(id) ? id : DEFAULT_THEME_ID, scheme) as keyof AppThemes;
}

StyleSheet.configure({
  themes,
  settings: {
    adaptiveThemes: false,
    initialTheme: initialTheme(),
  },
});
