/**
 * A metric over a window, one layered series per agent.
 *
 * THE chart for insights — spend, tokens, messages and sessions all draw here,
 * on every screen. There used to be a second one (a single-colour bar chart)
 * for the metrics that are plain counts, which meant the same window rendered
 * two different ways depending on which number you'd tapped, and the count
 * views couldn't answer "which agent" at all. Every metric this plots is a
 * field the bridge already reports per agent, so none of them had to stay
 * anonymous.
 *
 * Layered from a shared zero rather than stacked — see usageSeries.ts. Series
 * too small to see are not drawn at all; the caller is handed their names so it
 * can say so in words, which is the only honest way to render an agent that
 * spent $0.17 next to one that spent $6,980.
 *
 * Tap a bucket to read it. A hover tooltip is the desktop idiom and there is no
 * hover on a phone, so the readout is a line under the chart that both
 * platforms can use.
 */
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import Svg, { Line, Path } from "react-native-svg";
import type { ActivityDay } from "../services/activity";
import { agentLabel } from "../ui/tokens";
import {
  fmtCompact,
  fmtCost,
  fmtCostCompact,
  fmtCount,
  fmtDayLabel,
  fmtMonthLabel,
  fmtTokens,
} from "../ui/format";
import { buildPlot, plotScale, seriesPaths, type UsageMetric } from "./usageSeries";
import { useAgentHex, useThemeHex } from "../ui/useThemeHex";

const HEIGHT = 150;
/**
 * The y-axis labels sit INSIDE the plot, just above their own gridline, and the
 * plot spans the card's full width.
 *
 * A reserved column doesn't work here. Right-align it and a short tick ("4K")
 * leaves the rest of the column empty, so the card opens with a dead band
 * before the chart starts; left-align it and the numbers no longer line up with
 * the lines they label. Widening or narrowing the column only moves the problem
 * — the column has to fit "$100K" while usually holding two characters.
 *
 * Overlaying costs nothing: the top-left of a plot is the emptiest part of it
 * (a series that peaked at its first point is already at the top of the frame),
 * the labels are faint and small, and the gridline itself separates them from
 * the data below.
 *
 * Kept as an exported constant because callers used to subtract it from their
 * measured width. They no longer need to — it is 0 — but the export stays so
 * the arithmetic is stated in one place rather than assumed at three call sites.
 */
export const CHART_GUTTER = 0;
/** Label baseline above its gridline, and its inset from the left edge. */
const TICK_LIFT = 12;
const TICK_INSET = 1;

/** Each metric reads in its own units — a count formatted as tokens ("1.2K
 *  sessions") claims a precision the number doesn't have. */
const FORMAT: Record<UsageMetric, (n: number) => string> = {
  cost: fmtCost,
  tokens: fmtTokens,
  messages: fmtCount,
  sessions: fmtCount,
};

/**
 * The same numbers on the AXIS, compact.
 *
 * An axis tick is a scale marker, not a figure to quote: "40K" tells you where
 * you are on the plot as well as "40,000" does, in half the width. The exact
 * value still appears — in the readout, where someone actually reads it.
 */
const TICK_FORMAT: Record<UsageMetric, (n: number) => string> = {
  cost: fmtCostCompact,
  tokens: fmtCompact,
  messages: fmtCompact,
  sessions: fmtCompact,
};

export function UsageChart({
  days,
  agents,
  metric,
  width,
  granularity = "day",
  selected,
  onSelect,
}: {
  days: readonly ActivityDay[];
  /** Fixes the colour order, so a series keeps its hue as the metric toggles. */
  agents: readonly string[];
  metric: UsageMetric;
  /** Measured container width — the caller owns layout. */
  width: number;
  /** Labels only: a year is charted as monthly buckets whose date is the 1st,
   *  and calling that "Mar 1" would claim a day that isn't what it holds. */
  granularity?: "day" | "month";
  /**
   * Selected bucket date, when the caller owns the selection.
   *
   * CONTROLLED-OR-NOT on purpose. The Dashboard shares one selected day between
   * this chart and the contribution heatmap — two components with private state
   * would drift apart the moment you clicked either — while the Metric page has
   * nothing to share it with and shouldn't have to invent a state hook to say
   * so. Passing `selected` (with `onSelect`) takes over; omitting both keeps
   * the internal state.
   */
  selected?: string | null;
  onSelect?: (date: string) => void;
}) {
  const hex = useThemeHex();
  const hueOf = useAgentHex();
  const [ownPicked, setOwnPicked] = useState<number | null>(null);

  const plot = useMemo(() => buildPlot(days, agents, metric), [days, agents, metric]);
  const fmt = FORMAT[metric];
  const tick = TICK_FORMAT[metric];
  // Month labels carry the year: a 12-month window runs Aug→Aug, and an axis
  // reading "Aug" at both ends says nothing about which end is which.
  const labelOf = granularity === "month" ? fmtMonthLabel : fmtDayLabel;

  const controlled = onSelect != null;
  const picked = controlled
    ? selected == null
      ? null
      : (() => {
          const i = days.findIndex((d) => d.date === selected);
          return i < 0 ? null : i;
        })()
    : ownPicked;
  const pick = (i: number) => {
    if (controlled) {
      const d = days[i];
      if (d) onSelect(d.date);
    } else setOwnPicked(i);
  };

  const paths = useMemo(
    () =>
      plot.series.map((s) => ({
        agent: s.agent,
        hue: hueOf(s.agent, hex.accent)!,
        ...seriesPaths(s.values, plot.max, width, HEIGHT),
      })),
    [plot, width, hueOf, hex.accent],
  );

  if (!plot.series.length) {
    return (
      <View style={[s.empty, { height: HEIGHT }]}>
        <Text style={s.emptyText}>Nothing in this period</Text>
      </View>
    );
  }

  // The SAME mapping the curves are drawn with, so the gridlines, the tick
  // labels and the picked-day rule cannot drift off the series.
  const { step, toY } = plotScale(plot.max, width, HEIGHT, days.length);
  const day = picked == null ? null : days[picked];

  return (
    <View style={s.wrap}>
      <View style={s.plotRow}>
        <Pressable
          onPress={(e) => {
            if (step <= 0) return pick(0);
            const i = Math.round(e.nativeEvent.locationX / step);
            pick(Math.max(0, Math.min(days.length - 1, i)));
          }}
        >
          <Svg width={width} height={HEIGHT}>
            {plot.ticks.map((t) => (
              <Line
                key={t}
                x1={0}
                x2={width}
                y1={toY(t)}
                y2={toY(t)}
                stroke={hex.border}
                strokeWidth={1}
              />
            ))}
            {/* Every fill first, then every stroke, so no series can cover
                another's line. */}
            {paths.map((p) => (
              <Path key={`f-${p.agent}`} d={p.area} fill={p.hue} fillOpacity={0.14} />
            ))}
            {paths.map((p) => (
              <Path key={`l-${p.agent}`} d={p.line} fill="none" stroke={p.hue} strokeWidth={1.75} />
            ))}
            {picked == null ? null : (
              <Line
                x1={picked * step}
                x2={picked * step}
                y1={0}
                y2={HEIGHT}
                stroke={hex.fgMuted}
                strokeWidth={1}
              />
            )}
          </Svg>
          {/* Above the gridlines in the tree as well as on screen, so a label is
              never painted under the area fill it labels. */}
          {plot.ticks.map((t) => (
            <Text key={t} style={[s.tick, { top: Math.max(0, toY(t) - TICK_LIFT) }]}>
              {t === 0 ? "0" : tick(t)}
            </Text>
          ))}
        </Pressable>
      </View>

      <View style={s.dates}>
        <Text style={s.date}>{days[0] ? labelOf(days[0].date) : ""}</Text>
        <Text style={s.date}>
          {days[days.length - 1] ? labelOf(days[days.length - 1].date) : ""}
        </Text>
      </View>

      {/* The readout replaces the legend when a day is picked: naming the
          agents twice in the same spot is noise. */}
      {day ? (
        <Text style={s.readout}>
          <Text style={s.readoutDay}>{labelOf(day.date)}</Text>
          {plot.series.map((series) => {
            const v = series.values[picked!] ?? 0;
            return ` · ${agentLabel(series.agent)} ${fmt(v)}`;
          })}
        </Text>
      ) : (
        <View style={s.legend}>
          {paths.map((p) => (
            <View key={p.agent} style={s.legendItem}>
              {/* The same hue object the line is stroked with — a swatch that
                  disagrees with its own series is worse than no legend. */}
              <View style={[s.swatch, { backgroundColor: p.hue }]} />
              <Text style={s.legendLabel}>{agentLabel(p.agent)}</Text>
            </View>
          ))}
        </View>
      )}

      {plot.hidden.length ? (
        <Text style={s.hidden}>
          {plot.hidden.map(agentLabel).join(" and ")}
          {plot.hidden.length === 1 ? " is" : " are"} too small to plot here — see the rows above.
        </Text>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create((theme) => ({
  wrap: { gap: 6 },
  plotRow: { flexDirection: "row" },
  tick: {
    position: "absolute",
    left: TICK_INSET,
    fontFamily: "JetBrainsMono",
    fontSize: 9,
    color: theme.colors.fgFaint,
  },
  dates: { flexDirection: "row", justifyContent: "space-between", paddingLeft: CHART_GUTTER },
  date: { fontSize: 10, color: theme.colors.fgFaint },
  legend: { flexDirection: "row", flexWrap: "wrap", gap: 12, paddingLeft: CHART_GUTTER },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 5 },
  swatch: { width: 8, height: 8, borderRadius: 2 },
  legendLabel: { fontSize: 11, color: theme.colors.fgMuted },
  readout: { paddingLeft: CHART_GUTTER, fontSize: 11, color: theme.colors.fgMuted },
  readoutDay: { color: theme.colors.fg, fontWeight: "600" },
  hidden: {
    paddingLeft: CHART_GUTTER,
    fontSize: 10.5,
    lineHeight: 15,
    color: theme.colors.fgFaint,
  },
  empty: {
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
    backgroundColor: theme.colors.surfaceAlt,
  },
  emptyText: { fontSize: 12, color: theme.colors.fgFaint },
}));
