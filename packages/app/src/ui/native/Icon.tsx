import { Ionicons } from "@expo/vector-icons";
import type { PounceIconProps } from "./icon-map";

/** Cross-platform default (Android, macOS, Windows): plain Ionicons. The iOS
 *  variant (Icon.ios.tsx) renders SF Symbols — this file must never import
 *  expo-symbols, which is an iOS-only native module. */
export function PounceIcon({ name, size = 16, color, style }: PounceIconProps) {
  return <Ionicons name={name} size={size} color={color} style={style} />;
}
