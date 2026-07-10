import { useEffect, useRef, useState } from "react";
import { Animated, AppState, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as Updates from "expo-updates";
import { COLOR } from "../ui";

/** Re-check for updates when the app foregrounds, at most this often.
 *  Cold starts are covered natively by EXUpdatesCheckOnLaunch=ALWAYS. */
const FOREGROUND_CHECK_MS = 15 * 60 * 1000;

/**
 * OTA update UX: expo-updates downloads silently in the background; without
 * this the new version only lands on the *second* cold start. When a
 * downloaded update is pending, slide in a one-tap "Restart" pill so users
 * can apply it immediately — or ignore it and get it on next launch anyway.
 */
export function UpdateBanner() {
  const { isUpdatePending } = Updates.useUpdates();
  const insets = useSafeAreaInsets();
  const [dismissed, setDismissed] = useState(false);
  const slide = useRef(new Animated.Value(0)).current;

  // Foreground re-check for long-lived sessions (the launch check only runs
  // once per process). fetchUpdateAsync makes an available update pending.
  useEffect(() => {
    if (!Updates.isEnabled) return;
    let last = Date.now();
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active" || Date.now() - last < FOREGROUND_CHECK_MS) return;
      last = Date.now();
      void Updates.checkForUpdateAsync()
        .then((r) => (r.isAvailable ? Updates.fetchUpdateAsync() : null))
        .catch(() => {});
    });
    return () => sub.remove();
  }, []);

  const visible = Updates.isEnabled && isUpdatePending && !dismissed;

  useEffect(() => {
    Animated.spring(slide, {
      toValue: visible ? 1 : 0,
      useNativeDriver: true,
      friction: 9,
    }).start();
  }, [visible, slide]);

  if (!visible) return null;

  return (
    <Animated.View
      pointerEvents="box-none"
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: insets.bottom + 76, // clear the floating tab bar
        alignItems: "center",
        opacity: slide,
        transform: [{ translateY: slide.interpolate({ inputRange: [0, 1], outputRange: [24, 0] }) }],
      }}
    >
      <View className="flex-row items-center gap-2 rounded-full border border-accent/40 bg-bg-elevated py-2 pl-4 pr-2 shadow-lg">
        <Ionicons name="sparkles" size={14} color={COLOR.accent} />
        <Text className="text-[13px] font-medium text-fg">Update ready</Text>
        <Pressable
          onPress={() => void Updates.reloadAsync().catch(() => {})}
          className="active:opacity-80 h-8 items-center justify-center rounded-full bg-accent px-3.5"
        >
          <Text className="text-[13px] font-semibold text-white">Restart</Text>
        </Pressable>
        <Pressable
          onPress={() => setDismissed(true)}
          hitSlop={8}
          className="active:opacity-60 h-8 w-8 items-center justify-center"
        >
          <Ionicons name="close" size={16} color={COLOR.fgMuted} />
        </Pressable>
      </View>
    </Animated.View>
  );
}
