import { useColorScheme } from "react-native";
import { Stack } from "expo-router";
import { hexFor } from "@pounce/app/ui/theme-hex";
import { AppearanceButton } from "@pounce/app/components/AppearanceButton";

/** Per-tab stack so Settings gets a native large-title navigation bar.
 *  Header colors are literal scheme-picked hexes — react-native-screens
 *  resolves header colors against the system trait, so PlatformColors would
 *  ignore the forced light/dark toggle. */
export default function SettingsLayout() {
  const hex = hexFor(useColorScheme());
  return (
    <Stack
      screenOptions={{
        headerLargeTitle: true,
        headerTitleStyle: { color: hex.fg },
        headerLargeTitleStyle: { color: hex.fg },
        headerTintColor: hex.accent,
        contentStyle: { backgroundColor: hex.bg },
      }}
    >
      <Stack.Screen
        name="index"
        options={{ title: "Settings", headerRight: () => <AppearanceButton /> }}
      />
    </Stack>
  );
}
