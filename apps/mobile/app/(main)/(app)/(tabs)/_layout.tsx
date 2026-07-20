import { NativeTabs } from "expo-router/unstable-native-tabs";
import { COLOR } from "@pounce/app/ui/tokens";

/**
 * Home / Search / Settings on the system tab bar (UITabBarController on iOS,
 * BottomNavigationView on Android). The quick actions the old floating dock's
 * popups offered all live on the screens themselves (Home: New + filters,
 * Search: filters, Settings: refresh/sync), so the triggers are plain tabs.
 */
export default function TabsLayout() {
  return (
    <NativeTabs
      tintColor={COLOR.accent}
      // LegendList content under the bar can leave the scroll-edge glass fully
      // transparent; keep the bar legible over the dark thread lists.
      disableTransparentOnScrollEdge
      minimizeBehavior="onScrollDown"
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
        <NativeTabs.Trigger.Icon sf={{ default: "gearshape", selected: "gearshape.fill" }} md="settings" />
        <NativeTabs.Trigger.Label>Settings</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
