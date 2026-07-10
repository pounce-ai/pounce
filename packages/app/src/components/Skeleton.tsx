import { useEffect } from "react";
import { Text, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { Skeleton } from "boneyard-js/native";

/**
 * A static card-shaped template. Boneyard renders it, snapshots the native
 * layout, and shows pixel-perfect bones in its place while `loading`. The
 * placeholder text/sizes mirror a real SessionCard so the bones line up.
 */
function CardTemplate() {
  return (
    <View className="rounded-2xl border border-border bg-surface p-3.5">
      <View className="flex-row items-center gap-2">
        <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: "#777" }} />
        <Text className="flex-1 text-[15px] font-semibold text-fg" numberOfLines={1}>
          Refactor the auth flow
        </Text>
        <View style={{ width: 50, height: 18, borderRadius: 9, backgroundColor: "#777" }} />
      </View>
      <Text className="mt-1.5 text-[12px] text-fg-muted">mac-mini · api · feat/oauth-refresh</Text>
      <View className="mt-2 flex-row items-center justify-between">
        <Text className="text-[11px] text-fg-muted">awaiting input</Text>
        <Text className="text-[11px] text-fg-faint">2m</Text>
      </View>
    </View>
  );
}

/** One skeleton card (Boneyard bones of a SessionCard layout). */
export function SessionCardSkeleton() {
  return (
    <Skeleton loading dark darkColor="rgba(255,255,255,0.11)" animate="shimmer">
      <CardTemplate />
    </Skeleton>
  );
}

/** A stack of skeleton cards for the initial load. */
export function SessionListSkeleton({ count = 5 }: { count?: number }) {
  return (
    <View className="gap-2.5 px-4 pt-1.5" pointerEvents="none">
      {Array.from({ length: count }).map((_, i) => (
        <SessionCardSkeleton key={i} />
      ))}
    </View>
  );
}

/** One chat-bubble bone, sized/aligned like a real Timeline message. */
function BubbleBone({ user, lines }: { user: boolean; lines: 1 | 2 | 3 }) {
  const width = user ? "62%" : "80%";
  return (
    <View style={{ alignItems: user ? "flex-end" : "flex-start" }}>
      <View
        style={{
          maxWidth: "86%",
          width,
          height: 21 * lines + 20,
          borderRadius: 16,
          backgroundColor: "rgba(255,255,255,0.11)",
        }}
      />
    </View>
  );
}

/**
 * Chat-shaped bones for the initial history load — alternating bubbles that
 * mirror the Timeline layout, so the skeleton dissolves into real messages.
 * Drawn as plain pulsing Views (no Boneyard): the native snapshot pass can
 * silently produce nothing on this screen, which left a pitch-black timeline
 * for the whole history fetch.
 */
export function TimelineSkeleton() {
  const pulse = useSharedValue(1);
  useEffect(() => {
    pulse.value = withRepeat(
      withSequence(withTiming(0.45, { duration: 650 }), withTiming(1, { duration: 650 })),
      -1,
    );
  }, [pulse]);
  const style = useAnimatedStyle(() => ({ opacity: pulse.value }));
  // Real messages are bottom-anchored (the list opens at the newest), so anchor
  // the bones to the bottom and fill upward — otherwise they cluster at the top
  // over an empty black chat area.
  return (
    <Animated.View style={style} className="flex-1 justify-end gap-3 px-3 pb-3 pt-3" pointerEvents="none">
      <BubbleBone user lines={1} />
      <BubbleBone user={false} lines={2} />
      <BubbleBone user lines={2} />
      <BubbleBone user={false} lines={3} />
      <BubbleBone user={false} lines={1} />
      <BubbleBone user lines={1} />
      <BubbleBone user={false} lines={3} />
      <BubbleBone user lines={2} />
      <BubbleBone user={false} lines={2} />
    </Animated.View>
  );
}
