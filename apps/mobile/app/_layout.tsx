import "@pounce/app/polyfills"; // crypto.getRandomValues for @tanstack/db — must load first
import "../global.css";
import { useEffect } from "react";
import { router, Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { Providers } from "@pounce/app/components/Providers";
import { UpdateBanner } from "@pounce/app/components/UpdateBanner";
import { bootstrap } from "@pounce/app/services/runtime";
import { attachPushNavigation } from "@pounce/app/services/push";
import { attachNotificationTapHandler, initLocalNotifications } from "@pounce/app/services/notify";

export default function RootLayout() {
  useEffect(() => {
    void bootstrap();
    void initLocalNotifications();
    const detachPush = attachPushNavigation();
    // Local-notification taps carry a deep-link url (e.g. a thread waiting on
    // a prompt answer → its Session screen, which auto-presents the sheet).
    const detachTap = attachNotificationTapHandler((data) => {
      if (typeof data.url === "string") router.push(data.url as never);
    });
    return () => {
      detachPush();
      detachTap();
    };
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
        <Stack.Screen name="sessions" options={{ presentation: "modal" }} />
        <Stack.Screen name="new" options={{ presentation: "modal" }} />
        <Stack.Screen name="changes" options={{ presentation: "modal" }} />
        <Stack.Screen name="terminal" options={{ presentation: "modal" }} />
        <Stack.Screen name="connect" options={{ presentation: "modal" }} />
        <Stack.Screen name="help" options={{ presentation: "modal" }} />
        <Stack.Screen name="sync-history" options={{ presentation: "modal" }} />
        {/* Native form sheet (not an RN Modal) — sizes to the prompt's options. */}
        <Stack.Screen
          name="prompt/[id]"
          options={{
            presentation: "formSheet",
            sheetAllowedDetents: "fitToContents",
            sheetCornerRadius: 24,
            contentStyle: { backgroundColor: "#101016" }, // --color-bg-elevated
          }}
        />
      </Stack>
      <UpdateBanner />
    </Providers>
  );
}
