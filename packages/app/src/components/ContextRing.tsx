/**
 * Context-window fill, as a small ring beside the send button.
 *
 * Shows how full the conversation's window is right now — see ./contextFill for
 * what that measures and why it is not the thread's cumulative token total.
 * Renders nothing unless the agent reported both a window and a recent request
 * size, so a thread we can't measure honestly simply has no ring.
 */
import { Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import Svg, { Circle } from "react-native-svg";
import { contextFill } from "./contextFill";
import type { ThreadUsage } from "../services/bridge";

const SIZE = 28;
const STROKE = 2.5;

export function ContextRing({ usage }: { usage: ThreadUsage | null }) {
  const { theme } = useUnistyles();
  const fill = contextFill(usage);
  if (!fill) return null;

  const { pct, shown, used, window } = fill;
  // Calm until there's a reason to look, then escalate.
  const color =
    fill.level === "critical"
      ? theme.colors.danger
      : fill.level === "warn"
        ? theme.colors.warning
        : theme.colors.fgMuted;

  const r = (SIZE - STROKE) / 2;
  const circumference = 2 * Math.PI * r;

  return (
    <View
      style={s.wrap}
      accessibilityRole="progressbar"
      accessibilityLabel={`Context ${shown}% full — ${used.toLocaleString()} of ${window.toLocaleString()} tokens`}
    >
      <Svg width={SIZE} height={SIZE}>
        <Circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={r}
          stroke={theme.colors.border}
          strokeWidth={STROKE}
          fill="none"
        />
        <Circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={r}
          stroke={color}
          strokeWidth={STROKE}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - pct)}
          // Start the arc at 12 o'clock instead of 3.
          transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
        />
      </Svg>
      <Text style={[s.label, { color }]} numberOfLines={1}>
        {shown}
      </Text>
    </View>
  );
}

const s = StyleSheet.create((theme) => ({
  wrap: {
    height: SIZE,
    width: SIZE,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 4,
  },
  label: {
    position: "absolute",
    fontSize: 9,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
    color: theme.colors.fgMuted,
  },
}));
