import { Platform, useColorScheme } from "react-native";
import { NativeTabs } from "expo-router/unstable-native-tabs";
import { COLOR } from "@pounce/app/ui/tokens";
import { hexFor } from "@pounce/app/ui/theme-hex";

/**
 * Home / Search / Settings on the system tab bar (UITabBarController on iOS,
 * BottomNavigationView on Android). The quick actions the old floating dock's
 * popups offered all live on the screens themselves (Home: New + filters,
 * Search: filters, Settings: refresh/sync), so the triggers are plain tabs.
 */
export default function TabsLayout() {
  const hex = hexFor(useColorScheme());
  return (
    <NativeTabs
      tintColor={COLOR.accent}
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
            indicatorColor: "rgba(124, 111, 240, 0.22)",
          }
        : null)}
    >
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Icon sf={{ default: "house", selected: "house.fill" }} md="home" />
        <NativeTabs.Trigger.Label>Home</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="search" role="search">
        <NativeTabs.Trigger.Icon sf="magnifyingglass" md="search" />
        <NativeTabs.Trigger.Label>Search</NativeTabs.Trigger.Label>
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
