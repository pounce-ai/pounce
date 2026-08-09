/**
 * The pickable themes as unistyles themes — shared by all three platform
 * variants of unistyles-themes.*, which differ only in what `light` and `dark`
 * resolve to (the platform's own semantic palette, kept as the pre-hydration
 * fallback now that no theme selects it — see ui/palettes.ts).
 *
 * Unistyles registers every theme up front and switches between them by name;
 * `themeName()` in ui/palettes.ts is the single place that builds those names.
 */
import type { ColorValue } from "react-native";
import { THEMES, type Appearance, type ThemeId } from "./palettes";
import type { ThemeColor } from "./theme";

export type AppThemeColors = Record<ThemeColor, ColorValue>;
export type AppTheme = { colors: AppThemeColors };

/** Every pickable theme's registered name, e.g. `"ocean-dark"`. */
export type NamedThemeName = `${ThemeId}-${Appearance}`;

export const NAMED_THEMES = Object.fromEntries(
  THEMES.flatMap((t) => [
    [`${t.id}-light`, { colors: t.light }],
    [`${t.id}-dark`, { colors: t.dark }],
  ]),
) as Record<NamedThemeName, AppTheme>;

export type AppThemes = { light: AppTheme; dark: AppTheme } & Record<NamedThemeName, AppTheme>;
