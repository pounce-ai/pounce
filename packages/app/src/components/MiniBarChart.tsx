import { useMemo } from "react";
import { Pressable, Text, View, useColorScheme } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import Svg, { Rect } from "react-native-svg";
import { hexFor } from "../ui/theme-hex";

export interface Bar {
  readonly key: string;
  readonly value: number;
}

/**
 * A compact trend chart — bars only, no axes or gridlines. The point is the
 * shape of the series; exact values come from the tap-to-read detail line the
 * caller renders, so chrome that would compete with the data is left out.
 *
 * One <Svg> of <Rect>s (see ContributionGraph for why), width-driven so the
 * chart fills whatever column it's dropped into.
 */
export function MiniBarChart({
  bars,
  width,
  height = 96,
  selected,
  onSelect,
  emptyLabel = "No activity yet",
}: {
  bars: readonly Bar[];
  /** Measured container width — the caller owns layout. */
  width: number;
  height?: number;
  selected?: string | null;
  onSelect?: (key: string) => void;
  emptyLabel?: string;
}) {
  const hex = hexFor(useColorScheme());
  const max = useMemo(() => bars.reduce((m, b) => Math.max(m, b.value), 0), [bars]);

  if (!bars.length || max <= 0) {
    return (
      <View style={[s.empty, { height }]}>
        <Text style={s.emptyText}>{emptyLabel}</Text>
      </View>
    );
  }

  // Fill the width: at most 6px gaps, and never a sub-pixel bar.
  const gap = Math.min(6, Math.max(1, Math.floor(width / bars.length / 4)));
  const barW = Math.max(2, (width - gap * (bars.length - 1)) / bars.length);
  const step = barW + gap;

  return (
    <Pressable
      disabled={!onSelect}
      onPress={(e) => {
        const i = Math.floor(e.nativeEvent.locationX / step);
        const hit = bars[Math.max(0, Math.min(bars.length - 1, i))];
        if (hit) onSelect?.(hit.key);
      }}
    >
      <Svg width={width} height={height}>
        {bars.map((b, i) => {
          // Floor at 2px so a small-but-real day is still visible, and 0 stays
          // a flat baseline tick that reads as "nothing here".
          const h = b.value > 0 ? Math.max(2, (b.value / max) * height) : 1;
          const on = b.key === selected;
          return (
            <Rect
              key={b.key}
              x={i * step}
              y={height - h}
              width={barW}
              height={h}
              rx={Math.min(2, barW / 2)}
              fill={b.value > 0 ? (on ? hex.accent : hex.accentSoftSolid) : hex.border}
            />
          );
        })}
      </Svg>
    </Pressable>
  );
}

const s = StyleSheet.create((theme) => ({
  empty: {
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
    backgroundColor: theme.colors.surfaceAlt,
  },
  emptyText: { fontSize: 12, color: theme.colors.fgFaint },
}));
