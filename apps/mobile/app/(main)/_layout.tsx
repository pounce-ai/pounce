import { useColorScheme } from "react-native";
import { Stack } from "expo-router";
import { T } from "@pounce/app/ui/theme";
import { hexFor } from "@pounce/app/ui/theme-hex";

/** The main native stack — the base screen of the root TrueSheet navigator.
 *  `changes` and `filters` live OUTSIDE this group as true native sheets
 *  (see the root _layout); everything else keeps its stack presentation. */
export default function MainLayout() {
  // Subscribe to appearance changes: Android's Material dynamic colors only
  // re-resolve when the tree re-renders on a scheme flip (iOS adapts natively),
  // and the header hexes below are picked per scheme.
  const hex = hexFor(useColorScheme());

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: T.bg },
        // Navigation bars get LITERAL scheme-picked hexes, not PlatformColors:
        // react-native-screens resolves header colors against the system
        // trait, so semantic colors ignore the forced light/dark toggle
        // (white bar over a dark modal). Tint (buttons) carries the brand.
        headerStyle: { backgroundColor: hex.bgElevated },
        headerTitleStyle: { color: hex.fg },
        headerTintColor: hex.accent,
      }}
    >
      <Stack.Screen name="(app)" />
      <Stack.Screen name="session/[id]" />
      <Stack.Screen
        name="sessions"
        options={{ presentation: "modal", headerShown: true, title: "All sessions" }}
      />
      <Stack.Screen
        name="new"
        options={{ presentation: "modal", headerShown: true, title: "New task" }}
      />
      <Stack.Screen name="terminal" options={{ presentation: "modal" }} />
      <Stack.Screen name="connect" options={{ presentation: "modal" }} />
      <Stack.Screen
        name="help"
        options={{ presentation: "modal", headerShown: true, title: "Help" }}
      />
      <Stack.Screen
        name="sync-history"
        options={{ presentation: "modal", headerShown: true, title: "Sync history" }}
      />
      {/* Native form sheet (not an RN Modal) — sizes to the prompt's options.
          Stays on the router formSheet: its notification auto-present flow is
          battle-tested, so it does NOT move to the TrueSheet navigator. */}
      <Stack.Screen
        name="prompt/[id]"
        options={{
          presentation: "formSheet",
          sheetAllowedDetents: "fitToContents",
          sheetCornerRadius: 24,
          contentStyle: { backgroundColor: T.bgElevated },
        }}
      />
    </Stack>
  );
}
