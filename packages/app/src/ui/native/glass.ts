/**
 * Shared prop types for the glass primitives (GlassCard / GlassSurface).
 * A suffix-free module: desktop's tsconfig moduleSuffixes ([".macos", ""])
 * resolves "./GlassCard" from GlassCard.macos.tsx back to ITSELF (circular),
 * so the platform variants import shared types from here instead.
 */
import type { ReactNode } from "react";
import type { ColorValue, StyleProp, ViewStyle } from "react-native";

export interface GlassCardProps {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Corner radius of the card surface. */
  radius?: number;
  /** Interactive glass reacts to touches (iOS 26 only; ignored elsewhere). */
  interactive?: boolean;
  /** Soft drop shadow lifting the card off light backgrounds. */
  shadow?: boolean;
}

/** NSVisualEffectView material names (the useful subset). */
export type GlassMaterial =
  | "sidebar"
  | "titlebar"
  | "headerView"
  | "menu"
  | "popover"
  | "sheet"
  | "hudWindow"
  | "toolTip"
  | "contentBackground"
  | "windowBackground"
  | "underWindowBackground"
  | "underPageBackground"
  | "selection"
  | "fullScreenUI";

export interface GlassSurfaceProps {
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  material?: GlassMaterial;
  /** behindWindow blurs the desktop through the window (sidebars);
   *  withinWindow blurs window content underneath (cards, headers). */
  blendingMode?: "behindWindow" | "withinWindow";
  /** Rounds BOTH the blur backdrop and the children (native mask). */
  cornerRadius?: number;
  /** Paint when native vibrancy is unavailable (non-macOS, stale binary). */
  fallbackColor?: ColorValue;
}
