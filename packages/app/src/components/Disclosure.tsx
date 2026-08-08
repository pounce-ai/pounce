/**
 * The small motions a disclosure needs: a chevron that turns, and content that
 * arrives rather than appears.
 *
 * Built on React Native's CORE `Animated`, deliberately — not the Reanimated
 * seam next door. Reanimated 4 needs the New Architecture, which rn-macos isn't
 * on here, so `components/animation.tsx` stubs every tween to its end state on
 * desktop. Core Animated is the JS-driven API that predates all that and runs
 * everywhere this app does, which makes it the only way the desktop transcript
 * gets motion at all.
 *
 * Kept deliberately small. A transcript is a document; the animation's job is to
 * show that one thing became another, not to perform. Everything here is under
 * 200ms and nothing moves more than a few points.
 */
import { useEffect, useRef } from "react";
import { Animated, Easing, type ViewStyle } from "react-native";

/** Long enough to read as motion, short enough never to be in the way. */
const DURATION = 160;

/**
 * The standard ease for UI that's revealing something: quick to leave, gentle
 * to arrive. `Easing.out` is what stops a short tween feeling mechanical.
 */
const EASE = Easing.out(Easing.cubic);

/**
 * A chevron that rotates between two angles instead of swapping glyphs.
 *
 * Swapping `chevron-down` for `chevron-up` is a cut — the icon is simply a
 * different icon on the next frame. Turning the same glyph is what makes the
 * control feel like it moved, and it costs one transform.
 *
 * Native-driven: a rotation never touches layout, so it runs off the JS thread
 * and stays smooth while the list is scrolling or a turn is streaming.
 */
export function Chevron({
  open,
  children,
  /** Degrees to turn when open. 90 for a right-facing chevron becoming down,
   *  180 for a down-facing one becoming up. */
  turn = 90,
}: {
  open: boolean;
  children: React.ReactNode;
  turn?: number;
}) {
  const t = useRef(new Animated.Value(open ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(t, {
      toValue: open ? 1 : 0,
      duration: DURATION,
      easing: EASE,
      useNativeDriver: true,
    }).start();
  }, [open, t]);
  const rotate = t.interpolate({ inputRange: [0, 1], outputRange: ["0deg", `${turn}deg`] });
  return <Animated.View style={{ transform: [{ rotate }] }}>{children}</Animated.View>;
}

/**
 * Content that fades and lifts into place when it's revealed.
 *
 * No height animation, and that's a decision rather than a shortcut. Measuring
 * a block to tween its height forces a layout pass per frame, and inside a
 * recycled virtualized list (this renders in the transcript) that fights the
 * list's own size bookkeeping — the cure is worse than the cut it smooths. A
 * 6pt rise under a fade reads as "this arrived" without touching layout at all.
 *
 * Mounted only when open, so the tween runs from its initial value on mount.
 */
export function Reveal({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  const t = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(t, {
      toValue: 1,
      duration: DURATION,
      easing: EASE,
      useNativeDriver: true,
    }).start();
  }, [t]);
  return (
    <Animated.View
      style={[
        style,
        {
          opacity: t,
          transform: [{ translateY: t.interpolate({ inputRange: [0, 1], outputRange: [-6, 0] }) }],
        },
      ]}
    >
      {children}
    </Animated.View>
  );
}
