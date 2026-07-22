import { Ionicons } from "@expo/vector-icons";
import { SymbolView } from "expo-symbols";
import { SF_SYMBOL, type PounceIconProps } from "./icon-map";

/** iOS: SF Symbol when the name is mapped, Ionicon otherwise. */
export function PounceIcon({ name, size = 16, color, style }: PounceIconProps) {
  const sf = SF_SYMBOL[name];
  if (!sf) return <Ionicons name={name} size={size} color={color} style={style} />;
  // SymbolView sizes the frame; width can exceed `size` for wide glyphs, so
  // keep aspect fit and let callers treat `size` as the point size like before.
  return <SymbolView name={sf} size={size} tintColor={color} style={style as never} />;
}
