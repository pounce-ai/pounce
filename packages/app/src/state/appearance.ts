import { Appearance, NativeModules, Platform } from "react-native";
import { UnistylesRuntime } from "react-native-unistyles";
import { observable } from "@legendapp/state";
import { persist } from "../services/persistence";
import {
  DEFAULT_THEME_ID,
  isThemeId,
  themeName,
  type Appearance as Scheme,
  type ThemeId,
} from "../ui/palettes";

export type AppearanceMode = "system" | "light" | "dark";

/** Native window-level override — themes system chrome that RN's Appearance
 *  override doesn't reach. Two hosts, same setStyle contract:
 *  mobile = expo module (apps/mobile/modules/pounce-appearance) for UIKit
 *  chrome; desktop macOS = classic RN module (PounceGlass.mm) setting
 *  NSApp.appearance. Absent on Expo Go/Windows builds. */
type NativeAppearance = { setStyle(style: "light" | "dark" | "unspecified"): void };
let nativeChrome: NativeAppearance | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { requireNativeModule } = require("expo-modules-core");
  nativeChrome = requireNativeModule("PounceAppearance");
} catch {
  nativeChrome = null;
}
if (!nativeChrome) {
  const m = NativeModules.PounceAppearance as NativeAppearance | undefined;
  if (m && typeof m.setStyle === "function") nativeChrome = m;
}

/** User's appearance override. "system" follows the OS; light/dark force it
 *  app-wide (Appearance.setColorScheme re-resolves every PlatformColor). */
export const appearance$ = observable<AppearanceMode>("system");
persist(appearance$, "appearance");

/**
 * Chosen colour theme. The two settings are independent axes: this one picks
 * the PALETTE, appearance$ picks the GROUND it renders on — see ui/palettes.ts.
 */
export const theme$ = observable<ThemeId>(DEFAULT_THEME_ID);
persist(theme$, "theme");

// Apply on every change INCLUDING the async MMKV hydration — the root
// layout's mount-time call can run before the persisted value lands, which
// left the chips saying "Dark" over a light app.
appearance$.onChange(({ value }) => applyAppearance(value));
theme$.onChange(() => applyAppearance());

/** The ground the app is currently painting on. */
function resolveScheme(mode: AppearanceMode): Scheme {
  if (mode !== "system") return mode;
  return Appearance.getColorScheme() === "light" ? "light" : "dark";
}

/** Guards the re-entrancy between our own Appearance.setColorScheme call and
 *  the OS-change listener below, which both land here. */
let applying = false;

export function applyAppearance(mode: AppearanceMode = appearance$.get()) {
  if (applying) return;
  applying = true;
  try {
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
    // Adaptive themes only understand themes named light/dark, and ours
    // register as "<id>-<scheme>" — so resolve the scheme here and drive
    // setTheme (the OS listener below stands in for adaptive mode).
    try {
      UnistylesRuntime.setAdaptiveThemes(false);
      UnistylesRuntime.setTheme(
        themeName(theme$.peek(), resolveScheme(mode)) as Parameters<
          typeof UnistylesRuntime.setTheme
        >[0],
      );
    } catch {
      /* unistyles not configured (tests / unsupported host) */
    }
  } finally {
    applying = false;
  }
}

// With adaptive themes off, nothing else notices the OS flipping to dark while
// we're in "system" mode.
Appearance.addChangeListener(() => {
  if (appearance$.peek() === "system") applyAppearance("system");
});

export function setAppearance(mode: AppearanceMode) {
  appearance$.set(mode);
  applyAppearance(mode);
}

export function setTheme(id: ThemeId) {
  theme$.set(id);
  applyAppearance();
}

/** Persisted value read defensively — a downgrade or a hand-edited store can
 *  leave an id this build doesn't know. */
export function currentThemeId(): ThemeId {
  const id = theme$.get();
  return isThemeId(id) ? id : DEFAULT_THEME_ID;
}

/** The ground the app is painting on right now, for the few consumers that
 *  need a literal hex rather than a theme token (see ui/useThemeHex.ts). */
export function currentScheme(): Scheme {
  return resolveScheme(appearance$.get());
}
