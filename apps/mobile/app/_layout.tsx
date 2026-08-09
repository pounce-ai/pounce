import "@pounce/app/polyfills"; // crypto.getRandomValues for @tanstack/db — must load first
import { useEffect } from "react";
import { router, withLayoutContext } from "expo-router";
import { StatusBar } from "expo-status-bar";
import type { ParamListBase } from "@react-navigation/native";
import {
  createTrueSheetNavigator,
  type TrueSheetNavigationEventMap,
  type TrueSheetNavigationOptions,
  type TrueSheetNavigationState,
} from "@lodev09/react-native-true-sheet/navigation";
import { useThemeHex } from "@pounce/app/ui/useThemeHex";
import { applyAppearance } from "@pounce/app/state/appearance";
import { Providers } from "@pounce/app/components/Providers";
import { UpdateBanner } from "@pounce/app/components/UpdateBanner";
import { bootstrap } from "@pounce/app/services/runtime";
import { attachPushNavigation } from "@pounce/app/services/push";
import { attachNotificationTapHandler, initLocalNotifications } from "@pounce/app/services/notify";

// Root navigator = TrueSheet: `(main)` renders as the base screen (the whole
// stack lives inside it), and sibling routes present as REAL native sheets
// (UISheetPresentationController / BottomSheetDialog) — draggable, dimmed,
// with a grabber. Groups don't change URLs, so /changes and /filters keep
// their paths and every router.push call site works unchanged.
const { Navigator } = createTrueSheetNavigator();

const Sheet = withLayoutContext<
  TrueSheetNavigationOptions,
  typeof Navigator,
  TrueSheetNavigationState<ParamListBase>,
  TrueSheetNavigationEventMap
>(Navigator);

export default function RootLayout() {
  // Sheet backgrounds get LITERAL scheme-picked hexes, not PlatformColors:
  // the sheet's background resolves against the presented VC's traits, which
  // ignore the forced light/dark toggle (see NativeSheetTrue for the same trap).
  const hex = useThemeHex();
  useEffect(() => {
    applyAppearance(); // restore the persisted light/dark override before anything renders twice
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
      <StatusBar style="auto" />
      <Sheet
        initialRouteName="(main)" // base screen — deep links to a sheet inject (main) underneath (ensureBaseRoute)
        screenOptions={{
          dimmed: true,
          grabber: true,
          cornerRadius: 24,
          backgroundColor: hex.bgElevated,
        }}
      >
        <Sheet.Screen name="(main)" />
        {/* Filters as a native sheet; state is global (filters$), so the
            sheet needs no params and Home/Search react live as chips toggle. */}
        <Sheet.Screen name="filters" options={{ detents: ["auto", 1] }} />
        {/* Changes is a FULL screen (diff WebView + commit bar) presented as a
            draggable sheet — a large fixed detent, never 'auto' (a WebView has
            no intrinsic height to measure; the route wrapper sizes content). */}
        {/* No grabber: the header's chevron-down is the dismiss affordance and
            the reserved grabber strip read as an ugly dead band above it. */}
        <Sheet.Screen
          name="changes"
          options={{ detents: [0.99], backgroundColor: hex.bg, grabber: false }}
        />
      </Sheet>
      <UpdateBanner />
    </Providers>
  );
}
