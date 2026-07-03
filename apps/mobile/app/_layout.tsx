import "../global.css";
import { useEffect } from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { Providers } from "@/components/Providers";
import { bootstrap } from "@/services/runtime";
import { attachPushNavigation } from "@/services/push";

export default function RootLayout() {
  useEffect(() => {
    void bootstrap();
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
      </Stack>
    </Providers>
  );
}
