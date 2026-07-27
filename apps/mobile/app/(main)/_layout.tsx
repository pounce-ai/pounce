import { Pressable, useColorScheme } from "react-native";
import { router, Stack } from "expo-router";
import { PounceIcon } from "@pounce/app/ui/native/Icon";
import { T } from "@pounce/app/ui/theme";
import { hexFor } from "@pounce/app/ui/theme-hex";

/**
 * Leave a modal, always landing somewhere.
 *
 * `router.back()` alone is a trap when there's nothing behind the modal — a
 * deep link straight into it, or a navigation state that lost its parent. Then
 * the only way out is the swipe-down gesture, and if that doesn't take either,
 * the app is stuck with no visible exit. Falling back to the tabs means the
 * button can't dead-end.
 */
function dismissModal() {
  if (router.canGoBack()) router.back();
  else router.replace("/");
}

/**
 * Header close for a modal. Every modal in this stack gets one: relying on the
 * swipe gesture alone leaves no affordance on screen, and no recovery if the
 * gesture is unavailable.
 *
 * An icon, not a text label — iOS draws its own circular glass background
 * behind a custom header button, and a word sits in that circle badly. A single
 * glyph is what the treatment is shaped for.
 */
function closeButton(tint: string) {
  return function CloseButton() {
    return (
      <Pressable onPress={dismissModal} hitSlop={14} accessibilityLabel="Close">
        <PounceIcon name="close" size={17} color={tint} />
      </Pressable>
    );
  };
}

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
        options={{
          presentation: "modal",
          headerShown: true,
          title: "All sessions",
          headerLeft: closeButton(hex.accent),
        }}
      />
      <Stack.Screen
        name="new"
        options={{
          presentation: "modal",
          headerShown: true,
          title: "New task",
          headerLeft: closeButton(hex.accent),
        }}
      />
      <Stack.Screen
        name="context"
        options={{
          presentation: "modal",
          headerShown: true,
          title: "Project context",
          headerLeft: closeButton(hex.accent),
        }}
      />
      <Stack.Screen name="terminal" options={{ presentation: "modal" }} />
      <Stack.Screen name="connect" options={{ presentation: "modal" }} />
      <Stack.Screen
        name="help"
        options={{
          presentation: "modal",
          headerShown: true,
          title: "Help",
          headerLeft: closeButton(hex.accent),
        }}
      />
      <Stack.Screen
        name="sync-history"
        options={{
          presentation: "modal",
          headerShown: true,
          title: "Sync history",
          headerLeft: closeButton(hex.accent),
        }}
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
