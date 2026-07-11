import "@litter/app/polyfills"; // crypto.getRandomValues for @tanstack/db — must load first
import "../global.css";
import { useEffect } from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { Providers } from "@litter/app/components/Providers";
import { UpdateBanner } from "@litter/app/components/UpdateBanner";
import { bootstrap } from "@litter/app/services/runtime";
import { attachPushNavigation } from "@litter/app/services/push";
import { initLocalNotifications } from "@litter/app/services/notify";

export default function RootLayout() {
  useEffect(() => {
    void bootstrap();
    void initLocalNotifications();
    return attachPushNavigation();
  }, []);

  return (
    <Providers>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: "#0B0B0F" },
        }}
      >
        <Stack.Screen name="(app)" />
        <Stack.Screen name="session/[id]" />
        <Stack.Screen name="new" options={{ presentation: "modal" }} />
        <Stack.Screen name="changes" options={{ presentation: "modal" }} />
        <Stack.Screen name="terminal" options={{ presentation: "modal" }} />
        <Stack.Screen name="connect" options={{ presentation: "modal" }} />
        <Stack.Screen name="help" options={{ presentation: "modal" }} />
        <Stack.Screen name="sync-history" options={{ presentation: "modal" }} />
      </Stack>
      <UpdateBanner />
    </Providers>
  );
}
