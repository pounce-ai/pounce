import { useEffect } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
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
    <View style={s.card}>
      <View style={s.titleRow}>
        <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: "#777" }} />
        <Text style={s.title} numberOfLines={1}>
          Refactor the auth flow
        </Text>
        <View style={{ width: 50, height: 18, borderRadius: 9, backgroundColor: "#777" }} />
      </View>
      <Text style={s.meta}>mac-mini · api · feat/oauth-refresh</Text>
      <View style={s.footerRow}>
        <Text style={s.footerLeft}>awaiting input</Text>
        <Text style={s.footerRight}>2m</Text>
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
    <View style={s.list} pointerEvents="none">
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
    <Animated.View style={[style, TIMELINE_LAYOUT]} pointerEvents="none">
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

const s = StyleSheet.create((theme) => ({
  card: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    padding: 14,
  },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { flex: 1, fontSize: 15, fontWeight: "600", color: theme.colors.fg },
  meta: { marginTop: 6, fontSize: 12, color: theme.colors.fgMuted },
  footerRow: {
    marginTop: 8,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  footerLeft: { fontSize: 11, color: theme.colors.fgMuted },
  footerRight: { fontSize: 11, color: theme.colors.fgFaint },
  list: { gap: 10, paddingHorizontal: 16, paddingTop: 6 },
}));

/** Plain style for the pulsing Reanimated wrapper — unistyles sheet entries
 *  carry the C++ proxy, which Animated.View rejects. Layout-only. */
const TIMELINE_LAYOUT = {
  flex: 1,
  justifyContent: "flex-end",
  gap: 12,
  paddingHorizontal: 12,
  paddingBottom: 12,
  paddingTop: 12,
} as const;
