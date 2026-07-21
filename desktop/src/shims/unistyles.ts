/**
 * react-native-unistyles shim for the desktop shell (macOS/Windows — unistyles
 * has no desktop support). Mapped over the real package in metro.config.js
 * (EXACT table) and tsconfig paths, mirroring the expo-router shim.
 *
 * Contract: StyleSheet.create accepts the unistyles theme-function form and
 * resolves it ONCE against the desktop theme ({ colors: T } — AppKit semantic
 * PlatformColors, which macOS re-resolves natively on appearance changes, so
 * static creation still follows the system scheme). UnistylesRuntime is inert
 * and useUnistyles never re-renders — theme identity is stable.
 */
import { createElement, type ComponentType } from "react";
import {
  StyleSheet as RNStyleSheet,
  type ImageStyle,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { T } from "@pounce/app/ui/theme";

const desktopTheme = { colors: T };

export type AppTheme = typeof desktopTheme;

type NamedStyles<S> = { [P in keyof S]: ViewStyle | TextStyle | ImageStyle };
type MiniRuntime = Record<string, never>;

export const StyleSheet = {
  hairlineWidth: RNStyleSheet.hairlineWidth,
  absoluteFill: RNStyleSheet.absoluteFill,
  absoluteFillObject: RNStyleSheet.absoluteFillObject,
  flatten: RNStyleSheet.flatten,
  compose: RNStyleSheet.compose,
  /** No-op — themes are fixed on desktop; kept so shared config code links. */
  configure(_config: unknown): void {},
  create<S extends NamedStyles<S>>(sheet: S | ((theme: AppTheme, rt: MiniRuntime) => S)): S {
    return RNStyleSheet.create(typeof sheet === "function" ? sheet(desktopTheme, {}) : sheet);
  },
};

export const UnistylesRuntime = {
  /** No-op — desktop appearance is driven natively (PounceGlass NSApp.appearance). */
  setTheme(_name: "light" | "dark"): void {},
  /** No-op. */
  setAdaptiveThemes(_enabled: boolean): void {},
  get themeName(): "light" | "dark" {
    return "dark";
  },
  get hasAdaptiveThemes(): boolean {
    return true;
  },
};

export function useUnistyles(): { theme: AppTheme } {
  return { theme: desktopTheme };
}

/** Static stand-in for unistyles' HOC: applies the mapper once against the
 *  desktop theme (styles arriving via props are already plain objects here). */
export function withUnistyles<P extends object>(
  Component: ComponentType<P>,
  mappings?: (theme: AppTheme, rt: MiniRuntime) => Partial<P>,
): ComponentType<P> {
  if (!mappings) return Component;
  const mapped = mappings(desktopTheme, {});
  const Wrapped = (props: P) => createElement(Component, { ...mapped, ...props });
  return Wrapped;
}
