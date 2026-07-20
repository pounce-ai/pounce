import { Appearance, Platform } from "react-native";
import { observable } from "@legendapp/state";
import { persist } from "../services/persistence";

export type AppearanceMode = "system" | "light" | "dark";

/** Native window-level override (apps/mobile/modules/pounce-appearance) —
 *  themes UIKit chrome (nav bars, tab bar, sheets, keyboard) that RN's
 *  Appearance override doesn't reach. Absent on desktop/Expo Go builds. */
type NativeAppearance = { setStyle(style: "light" | "dark" | "unspecified"): void };
let nativeChrome: NativeAppearance | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { requireNativeModule } = require("expo-modules-core");
  nativeChrome = requireNativeModule("PounceAppearance");
} catch {
  nativeChrome = null;
}

/** User's appearance override. "system" follows the OS; light/dark force it
 *  app-wide (Appearance.setColorScheme re-resolves every PlatformColor). */
export const appearance$ = observable<AppearanceMode>("system");
persist(appearance$, "appearance");
// Apply on every change INCLUDING the async MMKV hydration — the root
// layout's mount-time call can run before the persisted value lands, which
// left the chips saying "Dark" over a light app.
appearance$.onChange(({ value }) => applyAppearance(value));

export function applyAppearance(mode: AppearanceMode = appearance$.get()) {
  // Clearing the override is spelled "unspecified" on RN 0.86 (mobile) but
  // null on the older desktop forks — and their d.ts disagree the same way,
  // hence the cast. try/catch guards forks without setColorScheme at all.
  const clear = Platform.OS === "macos" || Platform.OS === "windows" ? null : "unspecified";
  nativeChrome?.setStyle(mode === "system" ? "unspecified" : mode);
  try {
    Appearance.setColorScheme((mode === "system" ? clear : mode) as never);
  } catch {
    /* keep system appearance */
  }
}

export function setAppearance(mode: AppearanceMode) {
  appearance$.set(mode);
  applyAppearance(mode);
}
