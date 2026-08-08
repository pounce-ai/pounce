/**
 * An on/off switch in the app's own accent.
 *
 * React Native's `Switch` maps to a real NSSwitch on macOS, and NSSwitch paints
 * itself with the SYSTEM control accent — it ignores `trackColor` entirely.
 * That's why the one toggle in Settings came out iOS blue on a screen where
 * every other control is violet: not a missing prop, a control that can't be
 * told. Drawing it is the only way to make it agree with the rest of the app.
 *
 * Deliberately the same proportions as the platform switch, so it still reads
 * as one rather than as a novelty.
 */
import { Pressable, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

const W = 40;
const H = 23;
const PAD = 2.5;
const KNOB = H - PAD * 2;

export function Toggle({
  value,
  onValueChange,
  disabled,
  accessibilityLabel,
}: {
  value: boolean;
  onValueChange: (next: boolean) => void;
  disabled?: boolean;
  accessibilityLabel?: string;
}) {
  return (
    <Pressable
      onPress={() => !disabled && onValueChange(!value)}
      accessibilityRole="switch"
      accessibilityState={{ checked: value, disabled: !!disabled }}
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [
        s.track,
        value ? s.on : s.off,
        disabled && s.disabled,
        pressed && !disabled && s.pressed,
      ]}
    >
      {/* Position rather than a transform: this sits in a settings row that
          never animates, and a left offset is one value the layout already
          understands. */}
      <View style={[s.knob, { left: value ? W - KNOB - PAD : PAD }]} />
    </Pressable>
  );
}

const s = StyleSheet.create((theme) => ({
  track: {
    width: W,
    height: H,
    borderRadius: 999,
    justifyContent: "center",
  },
  on: { backgroundColor: theme.colors.accent },
  // A border when off, not a grey fill: an unfilled control reads as "off" at a
  // glance, and a solid grey pill on a light window looks like it's loading.
  off: { borderWidth: 1, borderColor: theme.colors.borderStrong },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.8 },
  knob: {
    position: "absolute",
    width: KNOB,
    height: KNOB,
    borderRadius: 999,
    backgroundColor: "#ffffff",
    shadowColor: "#000",
    shadowOpacity: 0.22,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 1 },
  },
}));
