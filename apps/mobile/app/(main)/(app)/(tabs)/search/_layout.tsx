import { Platform } from "react-native";
import { Stack } from "expo-router";
import { useThemeHex } from "@pounce/app/ui/useThemeHex";
import { router } from "expo-router";
import { FilterButton } from "@pounce/app/components/FilterSheet";
import { searchQuery$ } from "@pounce/app/state/search";

/** Per-tab stack: native UISearchBar in the navigation bar drives the shared
 *  Search screen through searchQuery$ (the screen has no input of its own on
 *  mobile). Pairs with the tab trigger's role="search". Header colors are
 *  literal scheme-picked hexes — react-native-screens resolves header colors
 *  against the system trait, so PlatformColors would ignore the forced
 *  light/dark toggle. */
export default function SearchLayout() {
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
        options={{
          title: "Search",
          headerRight: () => (
            <FilterButton active={false} onPress={() => router.push("/filters")} />
          ),
          headerSearchBarOptions: {
            placeholder: "Find a thread…",
            autoCapitalize: "none",
            textColor: hex.fg,
            hintTextColor: hex.fgMuted,
            headerIconColor: hex.fgMuted,
            hideWhenScrolling: false,
            onChangeText: (e) => searchQuery$.set(e.nativeEvent.text),
          },
        }}
      />
    </Stack>
  );
}
