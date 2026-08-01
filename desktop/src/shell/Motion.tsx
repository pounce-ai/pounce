/**
 * Desktop motion primitives.
 *
 * Reanimated is stubbed to a no-op on this platform (see
 * packages/app/src/components/animation.desktop.tsx — Reanimated 4 needs the
 * New Architecture, which react-native-macos isn't running here), so every
 * animation in the shared screens renders as its settled state. These helpers
 * use React Native's core Animated API instead, which does work, and stay on
 * the native driver so a busy JS thread doesn't stutter them.
 */
import { useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, View, type ViewProps } from "react-native";

/** One shared clock for shimmer bands so N skeleton rows animate in phase and
 *  cost one driver, not N. */
function useLoop(durationMs: number): Animated.Value {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    // No setValue here. Once a value has been driven natively, writing to it
    // from JS throws "Attempting to run JS driven animation on animated node
    // that has been moved to native" — and Animated.loop already rewinds to the
    // start of each iteration, so the reset bought nothing.
    const loop = Animated.loop(
      Animated.timing(v, {
        toValue: 1,
        duration: durationMs,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [v, durationMs]);
  return v;
}

/**
 * A highlight band that sweeps left→right across its parent.
 *
 * Drop it inside a clipped container (`overflow: "hidden"`); it fills the
 * parent and paints above the bones. Soft edges come from three stacked bands
 * of decreasing opacity rather than a gradient — expo-linear-gradient isn't a
 * desktop dependency, and this reads the same at this size.
 */
export function Shimmer({
  width,
  tint = "rgba(255,255,255,0.55)",
}: {
  width: number;
  tint?: string;
}) {
  const t = useLoop(1400);
  // Travel a full band-width beyond each edge so it enters and leaves cleanly.
  const translateX = t.interpolate({
    inputRange: [0, 1],
    outputRange: [-BAND, width + BAND],
  });
  return (
    // Not absoluteFill: with both left and right pinned, Yoga ignores the
    // band's width and it stretches across the whole block instead of sweeping.
    <Animated.View pointerEvents="none" style={[s.band, { transform: [{ translateX }] }]}>
      <View style={[s.slice, { opacity: 0.25, backgroundColor: tint }]} />
      <View style={[s.slice, { opacity: 0.6, backgroundColor: tint }]} />
      <View style={[s.slice, { opacity: 1, backgroundColor: tint }]} />
      <View style={[s.slice, { opacity: 0.6, backgroundColor: tint }]} />
      <View style={[s.slice, { opacity: 0.25, backgroundColor: tint }]} />
    </Animated.View>
  );
}

const BAND = 120;
const SLICE = BAND / 5;

/**
 * Fade + rise on mount, offset by row index so a list arrives as a ripple
 * rather than a slab. The delay is capped: past a dozen rows the stagger stops
 * reading as intentional and starts reading as lag.
 */
export function Entrance({
  index = 0,
  animate = true,
  children,
  style,
  ...rest
}: ViewProps & { index?: number; animate?: boolean }) {
  const t = useRef(new Animated.Value(animate ? 0 : 1)).current;
  useEffect(() => {
    // Nothing to settle when motion is off: the non-animated branch renders a
    // plain View that never reads `t`, and writing to a value the native driver
    // already owns is exactly what throws.
    if (!animate) return;
    const a = Animated.timing(t, {
      toValue: 1,
      duration: 260,
      delay: Math.min(index, 12) * 28,
      easing: Easing.out(Easing.cubic),
      // JS-driven, and settled to visible on teardown. This starts at opacity
      // 0, so a native animation that never runs would leave the rows
      // permanently invisible — the exact failure that blanked the detail pane
      // and the diff dock. Never let decoration decide whether content exists.
      useNativeDriver: false,
    });
    a.start();
    return () => {
      a.stop();
      t.setValue(1);
    };
  }, [t, index, animate]);
  // Once the list has settled this is a plain wrapper — recycled rows must not
  // replay their entrance every time they scroll back into view.
  if (!animate)
    return (
      <View style={style} {...rest}>
        {children}
      </View>
    );
  return (
    <Animated.View
      style={[
        style,
        {
          opacity: t,
          transform: [{ translateY: t.interpolate({ inputRange: [0, 1], outputRange: [6, 0] }) }],
        },
      ]}
      {...rest}
    >
      {children}
    </Animated.View>
  );
}

/**
 * Fade content in on mount. Give it a `key` that changes per view (the thread
 * id) and a tab switch replays it.
 *
 * Deliberately mount-only. An earlier version kept one Animated.Value and reset
 * it with `setValue(0)` on each change — but `setValue` on a value the native
 * driver has already taken over desyncs the native node, and the pane stayed
 * pinned at opacity 0: the whole detail area rendered blank. Two rules keep a
 * decorative fade from ever being able to hide the app:
 *   • never mutate a live driven value — remount for a fresh one instead;
 *   • settle to fully visible on unmount, so a torn-down animation can't
 *     strand content at zero.
 * It also runs off the native driver: opacity here is one view, and a JS-driven
 * value writes through the normal style path where a desync isn't possible.
 */
export function CrossFade({ children, style }: ViewProps) {
  const t = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const a = Animated.timing(t, {
      toValue: 1,
      duration: 180,
      easing: Easing.out(Easing.quad),
      useNativeDriver: false,
    });
    a.start();
    return () => {
      a.stop();
      t.setValue(1);
    };
  }, [t]);
  return <Animated.View style={[style, { opacity: t }]}>{children}</Animated.View>;
}

const s = StyleSheet.create({
  band: { position: "absolute", top: 0, bottom: 0, left: 0, width: BAND, flexDirection: "row" },
  slice: { width: SLICE, height: "100%" },
});
