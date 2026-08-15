/**
 * Is the window FULL SCREEN — and therefore, does the chrome still need to
 * leave room for the traffic lights?
 *
 * macOS hides the lights in full screen (they slide in only when you reach for
 * the top edge), so the 78pt of clearance reserved for them becomes a gap with
 * nothing in it and the sidebar's toggle floats in from the left for no visible
 * reason. Zoomed is NOT full screen: the buttons are still there and still need
 * the room.
 *
 * Measured from the shell's own root view rather than from `Dimensions`.
 * That's the whole point of this file: on react-native-macos `Dimensions.get
 * ("window")` returns the SCREEN, not the window, so comparing the two always
 * said "full screen" — which pushed the toggle to x=0 in a normal window, where
 * it landed underneath the red traffic light and disappeared. The root view's
 * layout is the window's real content box, and it can't lie.
 */
import { observable } from "@legendapp/state";
import { useSelector } from "@legendapp/state/react";
import { Dimensions, Platform } from "react-native";
import { TRAFFIC_LIGHT_INSET } from "@pounce/app/ui/native/DragRegion";

/** A browser tab has no traffic lights, ever — web is the full-screen case
 *  permanently, and reserving 78pt for absent buttons reads as a dead gap
 *  left of the first tab whenever the sidebar is hidden. */
const NEVER_HAS_LIGHTS = Platform.OS === "web";

const fullscreen$ = observable(false);

/**
 * Called by the Shell with the root view's measured height.
 *
 * Only full screen covers the menu bar, so a zoomed window is always shorter
 * than the display by at least that — the tolerance is loose enough for
 * rounding and tight enough never to match a zoomed window.
 */
export function reportWindowHeight(height: number): void {
  const screen = Dimensions.get("screen").height;
  if (!height || !screen) return;
  fullscreen$.set(height >= screen - 2);
}

/**
 * Clearance a top bar must leave for the traffic lights right now.
 *
 * `whenFullScreen` is what the bar falls back to once the lights are gone —
 * NOT zero by default for every caller, because a bar that hugs x=0 in full
 * screen is its own kind of wrong: the sidebar's toggle then sits flush against
 * the window edge while every row beneath it starts 14pt in. Callers pass the
 * inset that lines their first control up with their own content.
 */
export function useTrafficLightInset(whenFullScreen = 0): number {
  const fullscreen = useSelector(() => fullscreen$.get());
  return NEVER_HAS_LIGHTS || fullscreen ? whenFullScreen : TRAFFIC_LIGHT_INSET;
}
