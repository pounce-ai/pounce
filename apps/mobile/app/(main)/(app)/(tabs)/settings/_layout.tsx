import { Platform } from "react-native";
import { Stack } from "expo-router";
import { useThemeHex } from "@pounce/app/ui/useThemeHex";
import { AppearanceButton } from "@pounce/app/components/AppearanceButton";
import { SETTINGS_ROUTES } from "@pounce/app/screens/settings/routes";

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
        // Android's toolbar falls back to the theme's (light) surface even in
        // forced dark. iOS's large-title area is transparent over the page, so
        // it needs nothing here — see the sub-screens below for the bar that
        // DOES need painting.
        ...(Platform.OS === "android" ? { headerStyle: { backgroundColor: hex.bg } } : null),
      }}
    >
      <Stack.Screen
        name="index"
        options={{ title: "Settings", headerRight: () => <AppearanceButton /> }}
      />
      {/* Sub-screens keep a plain title bar: a second large title one push deep
          reads as another top level rather than a detail of the one above it.
          Titles come from the manifest the desktop shell also reads. */}
      {SETTINGS_ROUTES.map((r) => (
        <Stack.Screen
          key={r.name}
          name={r.name}
          options={{
            title: r.title,
            headerLargeTitle: false,
            // A plain (non-large) bar is a real surface, and iOS resolves its
            // colour against the SYSTEM trait: with the OS in light and the app
            // forced to Dark, it painted white over a dark page. Setting it on
            // the large-title screen instead would suppress that title.
            headerStyle: { backgroundColor: hex.bg },
          }}
        />
      ))}
    </Stack>
  );
}
