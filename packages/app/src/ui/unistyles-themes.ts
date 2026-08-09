/**
 * Unistyles theme pair (light/dark) — canonical shape + non-mobile fallback.
 * Platform truth lives in unistyles-themes.android.ts (Material-You roles
 * resolved for BOTH schemes up front) and unistyles-themes.ios.ts (the same
 * UIKit PlatformColors for both themes — iOS adapts natively, so unistyles
 * theme switching is a visual no-op there by design).
 *
 * This base file is what TypeScript resolves (and what any non-ios/android
 * bundle would get): both themes reuse the platform-default T tokens. The
 * desktop app never imports this — it shims react-native-unistyles entirely
 * (desktop/src/shims/unistyles.ts).
 *
 * `light`/`dark` are the platform semantic palette — no longer pickable, kept
 * as the pre-hydration fallback. The pickable themes (ui/palettes.ts) are
 * explicit hex and therefore identical on every platform, so they are shared
 * from unistyles-named.ts rather than repeated here.
 */
import { T } from "./theme";
import { NAMED_THEMES, type AppThemes } from "./unistyles-named";

export type { AppTheme, AppThemeColors, AppThemes } from "./unistyles-named";

export const themes: AppThemes = {
  light: { colors: { ...T } },
  dark: { colors: { ...T } },
  ...NAMED_THEMES,
};
