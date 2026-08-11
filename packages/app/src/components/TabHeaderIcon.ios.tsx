/**
 * iOS: the tab's glyph as a real SF Symbol.
 *
 * `sf`, not an Ionicon run through icon-map — the tab bar declares this same
 * icon as `sf="house.fill"`, and writing the header's copy the same way keeps
 * the two checkable against each other. See ./TabHeaderIcon.tsx for the shared
 * rationale and the Android half.
 */
import { ActivityIndicator, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { SymbolView } from "expo-symbols";
import { Stack } from "expo-router";
import type { TabHeaderIconProps } from "./TabHeaderIconTypes";

export function TabHeaderIcon({ sf, busy }: TabHeaderIconProps) {
  const { theme } = useUnistyles();
  return (
    <Stack.Toolbar placement="left">
      <Stack.Toolbar.View>
        <View style={s.slot}>
          {busy ? (
            <ActivityIndicator size="small" color={theme.colors.fgMuted} />
          ) : (
            <SymbolView name={sf} size={20} tintColor={theme.colors.accent} />
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
