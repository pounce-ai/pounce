import { Pressable, StyleSheet } from "react-native";
import { useSelector } from "@legendapp/state/react";
import { appearance$, setAppearance, type AppearanceMode } from "../state/appearance";
import { PounceIcon } from "../ui/native/Icon";
import { useThemeHex } from "../ui/useThemeHex";

const NEXT: Record<AppearanceMode, AppearanceMode> = {
  system: "light",
  light: "dark",
  dark: "system",
};

/** Icon per mode — the glyph shows the CURRENT mode; tapping cycles
 *  system → light → dark → system. */
const ICON: Record<AppearanceMode, "contrast" | "sunny" | "moon"> = {
  system: "contrast",
  light: "sunny",
  dark: "moon",
};

/** Header button cycling the app appearance. Lives in the navigation bar, so
 *  it colors with scheme-picked hexes like all header content (see the
 *  react-native-screens trait-resolution note in the layouts). */
export function AppearanceButton() {
  const mode = useSelector(() => appearance$.get());
  const hex = useThemeHex();
  return (
    <Pressable
      onPress={() => setAppearance(NEXT[mode])}
      hitSlop={10}
      accessibilityLabel={`Appearance: ${mode}. Tap to change.`}
      style={({ pressed }) => [s.btn, pressed && s.pressed]}
    >
      <PounceIcon name={ICON[mode]} size={18} color={hex.accent} />
    </Pressable>
  );
}

const s = StyleSheet.create({
  btn: { padding: 4 },
  pressed: { opacity: 0.6 },
});
