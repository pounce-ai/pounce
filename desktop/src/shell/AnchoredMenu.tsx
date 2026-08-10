/**
 * Titlebar popovers — the mechanism, once.
 *
 * A menu anchored to a control in a 28pt titlebar can't be a child of that
 * control: it would be clipped by the bar, and there'd be nothing to catch a
 * click elsewhere to dismiss it. So every one of these is split in two — the
 * button parks its measured position in an observable, and the shell draws the
 * card at those coordinates over the whole window.
 *
 * That split was hand-written per menu (OpenIn, then ThemeMenu copied it), and
 * the copies had already drifted in their edge clamp and shadow. This owns it:
 * `anchorStore()` per menu, `useAnchorButton()` for the control, `AnchoredMenu`
 * for the card.
 */
import { useCallback, useRef } from "react";
import { Pressable, View, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { observable, type Observable } from "@legendapp/state";
import { useSelector } from "@legendapp/state/react";
import type { ReactNode } from "react";

/** Where the button is, in window coordinates — null when the menu is shut. */
export type Anchor = { x: number; y: number; w: number } | null;
export type AnchorStore = Observable<{ anchor: Anchor }>;

export function anchorStore(): AnchorStore {
  return observable<{ anchor: Anchor }>({ anchor: null });
}

/**
 * Wire a titlebar control to its menu: returns whether the menu is open, the
 * ref to attach, and the press handler that measures and opens it.
 *
 * Measured at press time, not on layout — the titlebar reflows as controls come
 * and go (the access bell only exists while someone is asking), so a position
 * cached at mount drifts.
 */
export function useAnchorButton(store: AnchorStore) {
  const open = useSelector(() => store.anchor.get()) != null;
  const ref = useRef<View>(null);
  const onPress = useCallback(() => {
    if (store.anchor.peek()) return store.anchor.set(null);
    ref.current?.measureInWindow((x, y, w, h) => store.anchor.set({ x, y: y + h + 4, w }));
  }, [store]);
  return { open, ref, onPress };
}

/**
 * The card, drawn by the shell over the whole window. Renders nothing while
 * shut.
 *
 * `align` is the one real difference between these menus: a control at the LEFT
 * end of the bar left-aligns its card (right-aligning pushes it off the window),
 * and a control near the right edge does the opposite.
 */
export function AnchoredMenu({
  store,
  width,
  align = "left",
  style,
  children,
}: {
  store: AnchorStore;
  width: number;
  align?: "left" | "right";
  style?: ViewStyle;
  children: ReactNode;
}) {
  const anchor = useSelector(() => store.anchor.get());
  if (!anchor) return null;

  const left = align === "right" ? Math.max(8, anchor.x + anchor.w - width) : Math.max(8, anchor.x);

  return (
    <>
      {/* Full-window catcher, under the card: clicking anywhere else dismisses,
          which is what every other menu on this platform does. */}
      <Pressable style={StyleSheet.absoluteFill} onPress={() => store.anchor.set(null)} />
      <View style={[s.menu, { width, top: anchor.y, left }, style]}>{children}</View>
    </>
  );
}

const s = StyleSheet.create((theme) => ({
  menu: {
    position: "absolute",
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderStrong,
    backgroundColor: theme.colors.bgElevated,
    padding: 6,
    // The card floats over a transcript — without a shadow it reads as part of
    // the page rather than above it.
    shadowColor: "#000",
    shadowOpacity: 0.3,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
  },
}));
