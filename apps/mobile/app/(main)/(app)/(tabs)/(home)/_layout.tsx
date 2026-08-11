import { Platform } from "react-native";
import { Stack } from "expo-router";
import { useThemeHex } from "@pounce/app/ui/useThemeHex";

/**
 * Per-tab stack so Home gets a native large-title navigation bar, the same way
 * Search and Settings already do. Home is the FIRST tab and owns `/`, so it
 * lives in a route GROUP — `(home)` adds no path segment, which is what keeps
 * the root path (and every `pounce://` deep link that lands on it) intact.
 *
 * Header colors are literal scheme-picked hexes — react-native-screens resolves
 * header colors against the system trait, so PlatformColors would ignore the
 * forced light/dark toggle.
 */
export default function HomeLayout() {
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
      <Stack.Screen name="index" options={{ title: "Pounce" }} />
    </Stack>
  );
}
