import { Platform, Pressable, StyleSheet } from "react-native";
import { router, Stack } from "expo-router";
import { PounceIcon } from "@pounce/app/ui/native/Icon";
import { COLOR } from "@pounce/app/ui";
import { useThemeHex } from "@pounce/app/ui/useThemeHex";
import { METRIC_TITLE, type MetricKey } from "@pounce/app/screens/Metric";

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
      <Pressable onPress={dismissModal} hitSlop={14} accessibilityLabel="Close" style={s.close}>
        <PounceIcon name="close" size={18} color={tint} />
      </Pressable>
    );
  };
}

/** A titled modal with a close control. Every modal in this stack that shows a
 *  header wants exactly this, so adding one is a title rather than four keys —
 *  and the screens that deliberately skip it read as a choice, not an omission. */
const titled = (title: string, tint: string, bg: string) =>
  ({
    presentation: "modal",
    headerShown: true,
    title,
    headerLeft: closeButton(tint),
    // A plain (non-large) bar is a real surface and iOS resolves its colour
    // against the SYSTEM trait, so it needs painting here. It CANNOT live in
    // screenOptions: an opaque bar background suppresses a large title, which
    // is what left the Space and Metric headers blank.
    headerStyle: { backgroundColor: bg },
  }) as const;

/**
 * A pushed page — the native header, with the stack's own back chevron.
 *
 * NOT `titled`: these are drill-downs, not modals, so the way out is "back to
 * where I came from" and the control for that is a chevron the stack draws
 * itself. A ✕ would claim they're dismissable overlays, which is a different
 * promise about where you land.
 *
 * The title is a placeholder — every screen using this sets its own from its
 * own data (`<Stack.Screen options={{ title }} />`), which is the only place
 * that knows whether it is "Sessions" or "peppyhop". Declaring it here too
 * means the header has something to draw during the first frame.
 */
const pushed = (title: string) =>
  ({
    headerShown: true,
    title,
    // A large title, like every tab root. These are destination pages you drill
    // INTO and then read — a project's analytics, a metric opened up — not the
    // one-card detail sheets under Settings, which stay plain (see the
    // SETTINGS_ROUTES block) so a second large title one push deep doesn't read
    // as another top level.
    headerLargeTitle: true,
    // Chevron only. iOS labels the back button with the PREVIOUS screen's
    // title, and the previous screen here is the tab group — so it read
    // "‹ (app)", the route-group name leaking into the UI. There is no honest
    // one-word label either (you reach a metric from Activity and a space from
    // Home), and the chevron alone is unambiguous.
    headerBackButtonDisplayMode: "minimal",
  }) as const;

const s = StyleSheet.create({
  close: {
    // Symmetric padding keeps the glyph centred: iOS draws its circular glass
    // background around this frame, so uneven padding visibly shifts the ✕
    // off-centre inside the circle.
    alignItems: "center",
    justifyContent: "center",
    padding: 6,
    // Android left-aligns the title flush against headerLeft and needs a gap.
    // It has to be a margin — outside the frame — for the same reason.
    marginRight: Platform.OS === "android" ? 14 : 0,
  },
});

/** The main native stack — the base screen of the root TrueSheet navigator.
 *  `changes` and `filters` live OUTSIDE this group as true native sheets
 *  (see the root _layout); everything else keeps its stack presentation. */
export default function MainLayout() {
  // Subscribe to appearance changes: Android's Material dynamic colors only
  // re-resolve when the tree re-renders on a scheme flip (iOS adapts natively),
  // and the header hexes below are picked per scheme.
  const hex = useThemeHex();

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: COLOR.bg },
        // Navigation bars get LITERAL scheme-picked hexes, not PlatformColors:
        // react-native-screens resolves header colors against the system
        // trait, so semantic colors ignore the forced light/dark toggle
        // (white bar over a dark modal). Tint (buttons) carries the brand.
        //
        // NO headerStyle here. iOS's large-title area is transparent over the
        // page, and painting the bar opaque suppresses the large title — the
        // Space and Metric headers rendered blank until this moved out. The
        // screens that show a plain bar paint it themselves (see `titled`), the
        // same split settings/_layout makes. Android has no transparent
        // large-title area and does need it.
        ...(Platform.OS === "android" ? { headerStyle: { backgroundColor: hex.bg } } : null),
        headerTitleStyle: { color: hex.fg },
        // The LARGE title needs saying separately — it is a different label with
        // its own style, and it does not inherit `headerTitleStyle`. Left unset
        // it fell back to the system-trait colour, which is the very thing the
        // note above is about: with the OS in dark and the app forced light, the
        // space's name rendered white on a white bar and the header looked
        // simply empty.
        headerLargeTitleStyle: { color: hex.fg },
        headerTintColor: hex.accent,
      }}
    >
      <Stack.Screen name="(app)" />
      <Stack.Screen name="session/[id]" />
      <Stack.Screen name="sessions" options={titled("All sessions", hex.accent, hex.bg)} />
      <Stack.Screen name="new" options={titled("New task", hex.accent, hex.bg)} />
      <Stack.Screen name="context" options={titled("Project context", hex.accent, hex.bg)} />
      {/* Drill-downs from the Activity dashboard and the Home list. They used to
          be headerless and drew their own title INSIDE the scroll view, so the
          only way back scrolled off the top of a long analytics page.

          Their titles come from the ROUTE, not from the screen. A title the
          screen sets (`<Stack.Screen options>` from inside it) is dropped from
          the LARGE-title label whenever this navigator re-renders — which it
          does on every appearance flip, since its header hexes are
          scheme-picked — and the screen never re-applies it, so the header goes
          blank while the collapsed title stays correct. Read off the route
          here, the title is part of the same options the navigator re-applies. */}
      <Stack.Screen
        name="metric"
        options={({ route }) => {
          const key = (route.params as { key?: string } | undefined)?.key;
          return pushed(METRIC_TITLE[key as MetricKey] ?? "Metric");
        }}
      />
      <Stack.Screen
        name="space"
        options={({ route }) => {
          // Home passes the name alongside the key; a deep link that omits it
          // gets the generic word rather than an empty bar.
          const name = (route.params as { name?: string } | undefined)?.name;
          return pushed(name || "Space");
        }}
      />
      {/* No header, so no close button — these two present their own chrome. */}
      <Stack.Screen name="terminal" options={{ presentation: "modal" }} />
      <Stack.Screen name="connect" options={{ presentation: "modal" }} />
      <Stack.Screen name="help" options={titled("Help", hex.accent, hex.bg)} />
      <Stack.Screen name="sync-history" options={titled("Sync history", hex.accent, hex.bg)} />
      {/* Native form sheet (not an RN Modal) — sizes to the prompt's options.
          Stays on the router formSheet: its notification auto-present flow is
          battle-tested, so it does NOT move to the TrueSheet navigator. */}
      <Stack.Screen
        name="prompt/[id]"
        options={{
          presentation: "formSheet",
          sheetAllowedDetents: "fitToContents",
          sheetCornerRadius: 24,
          contentStyle: { backgroundColor: COLOR.bgElevated },
        }}
      />
    </Stack>
  );
}
