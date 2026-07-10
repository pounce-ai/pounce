/**
 * Loading skeletons — desktop variant.
 *
 * The mobile app uses Boneyard + Reanimated, neither of which builds on the
 * desktop platforms yet. Here the same shapes pulse with the core Animated API
 * instead; layouts mirror SessionCard / Timeline so bones dissolve into rows.
 */
import { useEffect, useRef } from "react";
import { Animated, Easing, View } from "react-native";

function usePulse(): Animated.Value {
  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 0.45,
          duration: 650,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 1,
          duration: 650,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  return pulse;
}

const BONE = "rgba(255,255,255,0.11)";

/** One skeleton card shaped like a SessionCard. */
export function SessionCardSkeleton() {
  return (
    <View className="rounded-2xl border border-border bg-surface p-3.5">
      <View className="flex-row items-center gap-2">
        <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: BONE }} />
        <View style={{ flex: 1, height: 14, borderRadius: 7, backgroundColor: BONE }} />
        <View style={{ width: 50, height: 18, borderRadius: 9, backgroundColor: BONE }} />
      </View>
      <View style={{ marginTop: 10, width: "55%", height: 10, borderRadius: 5, backgroundColor: BONE }} />
      <View className="mt-2 flex-row items-center justify-between">
        <View style={{ width: 84, height: 9, borderRadius: 5, backgroundColor: BONE }} />
        <View style={{ width: 22, height: 9, borderRadius: 5, backgroundColor: BONE }} />
      </View>
    </View>
  );
}

/** A stack of skeleton cards for the initial load. */
export function SessionListSkeleton({ count = 5 }: { count?: number }) {
  const pulse = usePulse();
  return (
    <Animated.View style={{ opacity: pulse }} className="gap-2.5 px-4 pt-1.5" pointerEvents="none">
      {Array.from({ length: count }).map((_, i) => (
        <SessionCardSkeleton key={i} />
      ))}
    </Animated.View>
  );
}

/** One chat-bubble bone: a real bubble shell holding thin text-line bones, so
 *  the skeleton dissolves into actual messages instead of giant blobs.
 *  Widths are percentages of the pane so the skeleton adapts to any window
 *  size instead of assuming a fixed-width column. */
function BubbleBone({ user, lines, width }: { user: boolean; lines: 1 | 2 | 3; width: `${number}%` }) {
  // Vary the last line so consecutive bones don't look stamped.
  const lineWidths = Array.from({ length: lines }, (_, i) =>
    i === lines - 1 ? "62%" : "100%",
  );
  return (
    <View style={{ alignItems: user ? "flex-end" : "flex-start" }}>
      <View
        style={{ width, maxWidth: "86%" }}
        className={cnBone(
          "rounded-2xl px-3 py-2.5",
          user ? "bg-surface-alt" : "border border-border bg-surface",
        )}
      >
        <View className="gap-2">
          {lineWidths.map((w, i) => (
            <View
              key={i}
              style={{ width: w as never, height: 10, borderRadius: 5, backgroundColor: BONE }}
            />
          ))}
        </View>
      </View>
    </View>
  );
}

// Tiny local join to avoid importing the ui barrel into the skeleton.
function cnBone(...parts: Array<string | false>): string {
  return parts.filter(Boolean).join(" ");
}

/** Chat-shaped bones for the initial history load. The real timeline opens
 *  pinned to the newest message, so the bones fill the pane from the BOTTOM
 *  up — enough rows that tall windows stay covered, extras clipped at the top. */
export function TimelineSkeleton() {
  const pulse = usePulse();
  const rows: { user: boolean; lines: 1 | 2 | 3; width: `${number}%` }[] = [
    { user: false, lines: 2, width: "58%" },
    { user: true, lines: 1, width: "36%" },
    { user: false, lines: 3, width: "72%" },
    { user: false, lines: 1, width: "44%" },
    { user: true, lines: 2, width: "40%" },
    { user: false, lines: 2, width: "66%" },
    { user: false, lines: 1, width: "52%" },
    { user: true, lines: 1, width: "30%" },
    { user: false, lines: 3, width: "70%" },
    { user: false, lines: 2, width: "62%" },
    { user: true, lines: 1, width: "38%" },
    { user: false, lines: 2, width: "68%" },
  ];
  return (
    <Animated.View
      style={{ opacity: pulse, justifyContent: "flex-end", overflow: "hidden" }}
      className="flex-1 gap-3 px-3 pb-3"
      pointerEvents="none"
    >
      {rows.map((r, i) => (
        <BubbleBone key={i} user={r.user} lines={r.lines} width={r.width} />
      ))}
    </Animated.View>
  );
}
