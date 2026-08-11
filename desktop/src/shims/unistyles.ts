/**
 * react-native-unistyles shim for the desktop shell (macOS/Windows — unistyles
 * has no desktop support). Mapped over the real package in metro.config.js
 * (EXACT table) and tsconfig paths, mirroring the expo-router shim.
 *
 * Contract: `StyleSheet.create` accepts the unistyles theme-function form and
 * resolves it against the ACTIVE theme.
 *
 * `light`/`dark` are `{ colors: T }` — AppKit semantic PlatformColors, kept as
 * the pre-hydration fallback. Every pickable theme (ui/palettes.ts) is explicit
 * hex and cannot re-resolve natively, so switching themes has to repaint sheets
 * that were created at module load. Hence the proxy: a
 * themed sheet resolves (and caches) per theme name on property access, so the
 * next render of a component picks up the new palette. App.tsx subscribes at
 * the root so that next render happens immediately, without remounting the
 * tree — a remount would tear down open terminals and tabs.
 */
import { createElement, useSyncExternalStore, type ComponentType } from "react";
import {
  StyleSheet as RNStyleSheet,
  type ImageStyle,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { T } from "@pounce/app/ui/theme";
import { NAMED_THEMES, type AppTheme } from "@pounce/app/ui/unistyles-named";

export type { AppTheme };

const systemTheme: AppTheme = { colors: { ...T } };

type ThemeName = "light" | "dark" | keyof typeof NAMED_THEMES;

/** Unknown names (and the `light`/`dark` fallback pair) resolve to the AppKit
 *  semantic palette, which adapts to the system appearance by itself. */
function themeFor(name: string): AppTheme {
  return (NAMED_THEMES as Record<string, AppTheme | undefined>)[name] ?? systemTheme;
}

let currentName: string = "dark";
const listeners = new Set<() => void>();

/** Bumped on every theme change so `useSyncExternalStore` sees a new snapshot
 *  (theme objects are stable across switches back and forth). */
let version = 0;

function setCurrentTheme(name: string): void {
  if (name === currentName) return;
  currentName = name;
  version += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getVersion = () => version;

/** Re-renders the caller whenever the active theme changes. */
function useThemeVersion(): number {
  return useSyncExternalStore(subscribe, getVersion, getVersion);
}

type NamedStyles<S> = { [P in keyof S]: ViewStyle | TextStyle | ImageStyle };

/**
 * The slice of unistyles' runtime the shared styles actually read.
 *
 * `insets` is the whole of it today. Shared sheets take their safe-area padding
 * from `rt.insets` rather than the useSafeAreaInsets hook, so this shim has to
 * answer for it or every one of those sheets throws here — it used to hand the
 * sheet function a bare `{}`.
 *
 * All ZERO, and that is the honest answer rather than a placeholder: a desktop
 * window has no notch, no home indicator and no software keyboard inset. The
 * chrome that needs breathing room on desktop asks for it in points.
 */
type MiniRuntime = {
  insets: { top: number; bottom: number; left: number; right: number; ime: number };
};

const DESKTOP_RUNTIME: MiniRuntime = {
  insets: { top: 0, bottom: 0, left: 0, right: 0, ime: 0 },
};

/** A sheet that re-resolves itself when the theme changes. Property access is
 *  what components do on every render (`s.row`), so that is where the current
 *  palette is read; results are cached per theme name. */
function themedSheet<S extends NamedStyles<S>>(fn: (theme: AppTheme, rt: MiniRuntime) => S): S {
  const cache = new Map<string, S>();
  // Hot path: every `s.foo` in every row of every render lands here, so the
  // steady state is an int compare rather than a string-keyed Map lookup.
  let live: S | null = null;
  let liveVersion = -1;
  const resolve = (): S => {
    if (live && liveVersion === version) return live;
    let sheet = cache.get(currentName);
    if (!sheet) {
      sheet = RNStyleSheet.create(fn(themeFor(currentName), DESKTOP_RUNTIME));
      cache.set(currentName, sheet);
    }
    live = sheet;
    liveVersion = version;
    return sheet;
  };
  return new Proxy({} as S, {
    get: (_t, prop) => resolve()[prop as keyof S],
    has: (_t, prop) => prop in (resolve() as object),
    ownKeys: () => Reflect.ownKeys(resolve() as object),
    getOwnPropertyDescriptor: (_t, prop) => {
      const descriptor = Object.getOwnPropertyDescriptor(resolve() as object, prop);
      return descriptor && { ...descriptor, configurable: true };
    },
  });
}

export const StyleSheet = {
  hairlineWidth: RNStyleSheet.hairlineWidth,
  absoluteFill: RNStyleSheet.absoluteFill,
  absoluteFillObject: RNStyleSheet.absoluteFillObject,
  flatten: RNStyleSheet.flatten,
  compose: RNStyleSheet.compose,
  /** No-op — the desktop theme registry is this file. Kept so shared config
   *  code links. */
  configure(_config: unknown): void {},
  create<S extends NamedStyles<S>>(sheet: S | ((theme: AppTheme, rt: MiniRuntime) => S)): S {
    return typeof sheet === "function" ? themedSheet(sheet) : RNStyleSheet.create(sheet);
  },
};

export const UnistylesRuntime = {
  setTheme(name: ThemeName): void {
    setCurrentTheme(name);
  },
  /** The active theme, for non-hook readers (ui/tokens.ts's COLOR proxy). */
  getTheme(name?: string): AppTheme {
    return themeFor(name ?? currentName);
  },
  /** No-op — desktop appearance is driven natively (PounceGlass
   *  NSApp.appearance) and by the theme name above. */
  setAdaptiveThemes(_enabled: boolean): void {},
  get themeName(): string {
    return currentName;
  },
  get hasAdaptiveThemes(): boolean {
    return false;
  },
};

export function useUnistyles(): { theme: AppTheme } {
  useThemeVersion();
  return { theme: themeFor(currentName) };
}

/** unistyles' HOC: applies the mapper against the active theme (styles
 *  arriving via props are already plain objects here). */
export function withUnistyles<P extends object>(
  Component: ComponentType<P>,
  mappings?: (theme: AppTheme, rt: MiniRuntime) => Partial<P>,
): ComponentType<P> {
  if (!mappings) return Component;
  const Wrapped = (props: P) => {
    useThemeVersion();
    return createElement(Component, { ...mappings(themeFor(currentName), DESKTOP_RUNTIME), ...props });
  };
  return Wrapped;
}
