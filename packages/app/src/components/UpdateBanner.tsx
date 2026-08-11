import { useEffect, useRef, useState } from "react";
import { Animated, AppState, Pressable, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { PounceIcon } from "../ui/native/Icon";
import * as Updates from "expo-updates";

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
  const { theme } = useUnistyles();
  const { isUpdatePending } = Updates.useUpdates();
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
      // ARRAY, not a spread: a unistyles style is a proxy whose values are
      // applied natively, and spreading it flattens that back into a plain JS
      // object — the animation would work and the safe-area inset would stop
      // updating itself.
      style={[
        s.host,
        {
          opacity: slide,
          transform: [
            { translateY: slide.interpolate({ inputRange: [0, 1], outputRange: [24, 0] }) },
          ],
        },
      ]}
    >
      <View style={s.pill}>
        <PounceIcon name="sparkles" size={14} color={theme.colors.accent} />
        <Text style={s.label}>Update ready</Text>
        <Pressable
          onPress={() => void Updates.reloadAsync().catch(() => {})}
          style={({ pressed }) => [s.restartBtn, pressed && s.pressed80]}
        >
          <Text style={s.restartText}>Restart</Text>
        </Pressable>
        <Pressable
          onPress={() => setDismissed(true)}
          hitSlop={8}
          style={({ pressed }) => [s.closeBtn, pressed && s.pressed60]}
        >
          <PounceIcon name="close" size={16} color={theme.colors.fgMuted} />
        </Pressable>
      </View>
    </Animated.View>
  );
}

const s = StyleSheet.create((theme, rt) => ({
  /** Floats above the system tab bar. The offset is safe-area padding, so it
   *  belongs in the sheet — applied natively, no re-render. */
  host: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: rt.insets.bottom + 60,
    alignItems: "center",
  },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: theme.colors.accentLine,
    backgroundColor: theme.colors.bgElevated,
    paddingVertical: 8,
    paddingLeft: 16,
    paddingRight: 8,
  },
  label: { fontSize: 13, fontWeight: "500", color: theme.colors.fg },
  restartBtn: {
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 999,
    backgroundColor: theme.colors.accent,
    paddingHorizontal: 14,
  },
  restartText: { fontSize: 13, fontWeight: "600", color: theme.colors.onAccent },
  closeBtn: { height: 32, width: 32, alignItems: "center", justifyContent: "center" },
  pressed60: { opacity: 0.6 },
  pressed80: { opacity: 0.8 },
}));
