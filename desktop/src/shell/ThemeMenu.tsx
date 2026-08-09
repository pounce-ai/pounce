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
import { useRef } from "react";
import { Pressable, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { observable } from "@legendapp/state";
import { useSelector } from "@legendapp/state/react";
import { Ionicons } from "@expo/vector-icons";
import { COLOR } from "@pounce/app/ui";
import { ThemePicker } from "@pounce/app/components/ThemePicker";

/** Where the button is, in window coordinates — null when the menu is shut. */
const themeMenu$ = observable<{ anchor: { x: number; y: number; w: number } | null }>({
  anchor: null,
});

/** Fixed so the card doesn't resize as themes are added. Wide enough for a
 *  swatch strip, a name and its one-line description on one row. */
const MENU_W = 268;

export function ThemeButton() {
  const open = useSelector(() => themeMenu$.anchor.get()) != null;
  const ref = useRef<View>(null);

  return (
    <View ref={ref} collapsable={false}>
      <Pressable
        onPress={() => {
          if (open) return themeMenu$.anchor.set(null);
          // Measured at press time, not on layout: the titlebar reflows as
          // controls appear (the access bell is only there when someone is
          // asking), and a position cached at mount would drift.
          ref.current?.measureInWindow((x, y, w, h) =>
            themeMenu$.anchor.set({ x, y: y + h + 4, w }),
          );
        }}
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

/** The popover, drawn by the shell over the whole window. */
export function ThemeMenu() {
  const anchor = useSelector(() => themeMenu$.anchor.get());
  if (!anchor) return null;

  const close = () => themeMenu$.anchor.set(null);

  return (
    <>
      {/* Full-window catcher, under the card: clicking anywhere else dismisses,
          which is what every other menu on this platform does. */}
      <Pressable style={StyleSheet.absoluteFill} onPress={close} />
      <View
        style={[
          s.menu,
          {
            top: anchor.y,
            // Left-aligned to the button: this control sits at the LEFT end of
            // the sidebar's titlebar, so right-aligning would push the card off
            // the window edge.
            left: Math.max(8, anchor.x),
          },
        ]}
      >
        {/* Deliberately stays open after a pick. Choosing a theme is a
            comparison, and a menu that dismissed itself would hide the thing
            you're comparing against. */}
        <ThemePicker />
      </View>
    </>
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
  menu: {
    position: "absolute",
    width: MENU_W,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderStrong,
    backgroundColor: theme.colors.bgElevated,
    padding: 8,
    shadowColor: "#000",
    shadowOpacity: 0.3,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
  },
}));
