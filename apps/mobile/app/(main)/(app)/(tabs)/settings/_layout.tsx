import { Platform } from "react-native";
import { Stack } from "expo-router";
import { useThemeHex } from "@pounce/app/ui/useThemeHex";
import { AppearanceButton } from "@pounce/app/components/AppearanceButton";

/** Per-tab stack so Settings gets a native large-title navigation bar.
 *  Header colors are literal scheme-picked hexes — react-native-screens
 *  resolves header colors against the system trait, so PlatformColors would
 *  ignore the forced light/dark toggle. */
export default function SettingsLayout() {
  const hex = useThemeHex();
  return (
    <Stack
      screenOptions={{
        headerLargeTitle: true,
        headerTitleStyle: { color: hex.fg },
        headerLargeTitleStyle: { color: hex.fg },
        headerTintColor: hex.accent,
        contentStyle: { backgroundColor: hex.bg },
        // iOS keeps the system scroll-edge bar; Android's toolbar otherwise
        // falls back to the theme's (light) surface even in forced dark.
        ...(Platform.OS === "android" ? { headerStyle: { backgroundColor: hex.bg } } : null),
      }}
    >
      <Stack.Screen
        name="index"
        options={{ title: "Settings", headerRight: () => <AppearanceButton /> }}
      />
    </Stack>
  );
}
