/**
 * Loading skeletons — desktop variant.
 *
 * The mobile app uses Boneyard + Reanimated, neither of which builds on the
 * desktop platforms yet. Here the same shapes pulse with the core Animated API
 * instead; layouts mirror SessionCard / Timeline so bones dissolve into rows.
 */
import { useEffect, useRef } from "react";
import { Animated, Easing, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { COLOR } from "../ui";
import { ActivityBones } from "./ActivityBones";

export function usePulse(): Animated.Value {
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

/**
 * Bone fill. A semantic surface, not a white overlay: `rgba(255,255,255,…)`
 * only reads as a bone on a dark background — in the light appearance it was
 * white-on-white and the whole skeleton vanished.
 *
 * Read through COLOR on every call rather than hoisted into a constant: a
 * module-scope read freezes the palette the app booted with, which is wrong
 * the moment the user picks a theme (see ui/tokens.ts).
 */
const bone = () => COLOR.surfaceHover;

/** One skeleton card shaped like a SessionCard. */
export function SessionCardSkeleton() {
  return (
    <View style={s.card}>
      <View style={s.titleRow}>
        <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: bone() }} />
        <View style={{ flex: 1, height: 14, borderRadius: 7, backgroundColor: bone() }} />
        <View style={{ width: 50, height: 18, borderRadius: 9, backgroundColor: bone() }} />
      </View>
      <View
        style={{
          marginTop: 10,
          width: "55%",
          height: 10,
          borderRadius: 5,
          backgroundColor: bone(),
        }}
      />
      <View style={s.footerRow}>
        <View style={{ width: 84, height: 9, borderRadius: 5, backgroundColor: bone() }} />
        <View style={{ width: 22, height: 9, borderRadius: 5, backgroundColor: bone() }} />
      </View>
    </View>
  );
}

/** A stack of skeleton cards for the initial load. */
export function SessionListSkeleton({ count = 5 }: { count?: number }) {
  const pulse = usePulse();
  return (
    <Animated.View style={[s.list, { opacity: pulse }]} pointerEvents="none">
      {Array.from({ length: count }).map((_, i) => (
        <SessionCardSkeleton key={i} />
      ))}
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
  footerRow: {
    marginTop: 8,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  list: { gap: 10, paddingHorizontal: 16, paddingTop: 6 },
}));

/** Activity-shaped bones — desktop pulse (core Animated), shared layout. */
export function ActivitySkeleton() {
  const pulse = usePulse();
  return (
    <Animated.View style={{ opacity: pulse }} pointerEvents="none">
      <ActivityBones />
    </Animated.View>
  );
}
