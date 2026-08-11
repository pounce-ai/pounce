import { Platform } from "react-native";
import { NativeTabs } from "expo-router/unstable-native-tabs";
import { useThemeHex } from "@pounce/app/ui/useThemeHex";
import { alpha } from "@pounce/app/ui/color";

/**
 * Home / Search / Activity / Settings on the system tab bar
 * (UITabBarController on iOS, BottomNavigationView on Android). The quick
 * actions the old floating dock's popups offered all live on the screens
 * themselves (Home: New + filters, Search: filters, Settings: refresh/sync), so
 * the triggers are plain tabs.
 */
export default function TabsLayout() {
  const hex = useThemeHex();
  return (
    <NativeTabs
      // hex.accent, not COLOR.accent: COLOR is a non-subscribing read, so the
      // bar would keep the palette it mounted with.
      tintColor={hex.accent}
      // LegendList content under the bar can leave the scroll-edge glass fully
      // transparent; keep the bar legible over the dark thread lists.
      disableTransparentOnScrollEdge
      minimizeBehavior="onScrollDown"
      // Android's BottomNavigationView colors come from the Activity theme,
      // which never follows the in-app appearance toggle — drive them from the
      // JS scheme instead. iOS keeps the untinted native glass bar.
      {...(Platform.OS === "android"
        ? {
            backgroundColor: hex.bgElevated,
            iconColor: hex.fgMuted,
            labelStyle: { color: hex.fgMuted },
            indicatorColor: alpha(hex.accent, 0.22),
          }
        : null)}
    >
      {/* `(home)` is a route GROUP, not a path segment: Home keeps `/`, and
          gets its own stack for a native large title. */}
      <NativeTabs.Trigger name="(home)">
        <NativeTabs.Trigger.Icon sf={{ default: "house", selected: "house.fill" }} md="home" />
        <NativeTabs.Trigger.Label>Home</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="search" role="search">
        <NativeTabs.Trigger.Icon sf="magnifyingglass" md="search" />
        <NativeTabs.Trigger.Label>Search</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="activity">
        <NativeTabs.Trigger.Icon
          sf={{ default: "chart.bar", selected: "chart.bar.fill" }}
          md="insert_chart"
        />
        <NativeTabs.Trigger.Label>Activity</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="settings">
        <NativeTabs.Trigger.Icon
          sf={{ default: "gearshape", selected: "gearshape.fill" }}
          md="settings"
        />
        <NativeTabs.Trigger.Label>Settings</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
