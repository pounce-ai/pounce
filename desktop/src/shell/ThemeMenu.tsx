/**
 * Theme switcher for the desktop titlebar.
 *
 * The full picker lives in Settings, but a palette is something people try on
 * — flip, look at the window, flip again — and routing to Settings for each
 * flip means never seeing the app you're theming. So the sidebar gets the same
 * one-click treatment appearance already has, sitting right next to it.
 *
 * Split across two exports for the same reason as OpenIn: a popover clipped to
 * a 28pt titlebar has nowhere to go and no way to be dismissed by clicking away
 * from it. The button measures itself, parks its position in an observable, and
 * the shell draws the menu at those coordinates over the whole window.
 */
import { Pressable, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Ionicons } from "@expo/vector-icons";
import { useColors } from "@pounce/app/ui/tokens";
import { ThemePicker } from "@pounce/app/components/ThemePicker";
import { AnchoredMenu, anchorStore, useAnchorButton } from "./AnchoredMenu";

const themeMenu$ = anchorStore();

/** Fixed so the card doesn't resize as themes are added. Wide enough for a
 *  swatch strip, a name and its one-line description on one row. */
const MENU_W = 268;

export function ThemeButton() {
  const COLOR = useColors();
  const { open, ref, onPress } = useAnchorButton(themeMenu$);

  return (
    <View ref={ref} collapsable={false}>
      <Pressable
        onPress={onPress}
        accessibilityLabel="Theme"
        style={({ pressed }) => [s.titleBarIcon, (pressed || open) && s.hover]}
      >
        <Ionicons
          name="color-palette-outline"
          size={14}
          color={open ? COLOR.accent : COLOR.fgMuted}
        />
      </Pressable>
    </View>
  );
}

/** The popover, drawn by the shell over the whole window. Left-aligned: this
 *  control sits at the LEFT end of the sidebar's titlebar. */
export function ThemeMenu() {
  return (
    <AnchoredMenu store={themeMenu$} width={MENU_W} align="left">
      {/* Deliberately stays open after a pick. Choosing a theme is a comparison,
          and a menu that dismissed itself would hide what you're comparing
          against. */}
      <ThemePicker />
    </AnchoredMenu>
  );
}

const s = StyleSheet.create((theme) => ({
  titleBarIcon: {
    height: 22,
    width: 22,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 5,
  },
  hover: { backgroundColor: theme.colors.surfaceHover },
}));
