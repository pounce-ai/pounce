/**
 * A tab's own glyph, at the leading edge of its navigation bar.
 *
 * The same icon the tab bar draws for that tab, so a screen says what it is at
 * both ends of the screen. Home used to put a paw here, which was a brand mark
 * rather than an orientation cue — it said "Pounce", which the title beside it
 * already said.
 *
 * Decorative, so it goes in a `Toolbar.View` rather than a `Toolbar.Button`:
 * nothing happens when you press it, and a button that does nothing is worse
 * than a picture.
 *
 * DEFAULT variant — Android and the desktop platforms. Android draws the
 * Material icon (`md`), the same family the tab bar's `md=` prop uses, from the
 * font @expo/vector-icons already ships. iOS resolves TabHeaderIcon.ios.tsx and
 * draws a real SF Symbol instead; this file must never import expo-symbols,
 * which is an iOS-only native module.
 */
import { ActivityIndicator, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { MaterialIcons } from "@expo/vector-icons";
import { Stack } from "expo-router";
import { IS_DESKTOP } from "../ui";
import type { TabHeaderIconProps } from "./TabHeaderIconTypes";

export function TabHeaderIcon({ md, busy }: TabHeaderIconProps) {
  const { theme } = useUnistyles();
  // Desktop has no navigation bar to lead.
  if (IS_DESKTOP) return null;
  return (
    <Stack.Toolbar placement="left">
      <Stack.Toolbar.View>
        <View style={s.slot}>
          {busy ? (
            <ActivityIndicator size="small" color={theme.colors.fgMuted} />
          ) : (
            <MaterialIcons name={md} size={22} color={theme.colors.accent} />
          )}
        </View>
      </Stack.Toolbar.View>
    </Stack.Toolbar>
  );
}

const s = StyleSheet.create({
  /** A fixed box so the glyph and the spinner occupy the same space — the bar
   *  must not shift sideways when a sync starts. */
  slot: { width: 24, alignItems: "center", justifyContent: "center" },
});
