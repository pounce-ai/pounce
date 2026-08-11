/**
 * Daily usage over a window, one layered series per agent.
 *
 * Layered from a shared zero rather than stacked — see usageSeries.ts. Series
 * too small to see are not drawn at all; the caller is handed their names so it
 * can say so in words, which is the only honest way to render an agent that
 * spent $0.17 next to one that spent $6,980.
 *
 * Tap a day to read it. A hover tooltip is the desktop idiom and there is no
 * hover on a phone, so the readout is a line under the chart that both
 * platforms can use.
 */
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import Svg, { Line, Path } from "react-native-svg";
import type { ActivityDay } from "../services/activity";
import { agentLabel } from "../ui/tokens";
import { fmtCost, fmtDayLabel, fmtTokens } from "../ui/format";
import { buildPlot, plotScale, seriesPaths, type UsageMetric } from "./usageSeries";
import { useAgentHex, useThemeHex } from "../ui/useThemeHex";

const HEIGHT = 150;

export function UsageChart({
  days,
  agents,
  metric,
  width,
}: {
  days: readonly ActivityDay[];
  /** Fixes the colour order, so a series keeps its hue as the metric toggles. */
  agents: readonly string[];
  metric: UsageMetric;
  /** Measured container width — the caller owns layout. */
  width: number;
}) {
  const hex = useThemeHex();
  const hueOf = useAgentHex();
  const [picked, setPicked] = useState<number | null>(null);

  const plot = useMemo(() => buildPlot(days, agents, metric), [days, agents, metric]);
  const fmt = metric === "cost" ? fmtCost : fmtTokens;

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
        <View style={[s.axis, { height: HEIGHT }]}>
          {plot.ticks.map((t) => (
            <Text key={t} style={[s.tick, { top: toY(t) - 6 }]}>
              {t === 0 ? "0" : fmt(t)}
            </Text>
          ))}
        </View>

        <Pressable
          onPress={(e) => {
            if (step <= 0) return setPicked(0);
            const i = Math.round(e.nativeEvent.locationX / step);
            setPicked(Math.max(0, Math.min(days.length - 1, i)));
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
        </Pressable>
      </View>

      <View style={s.dates}>
        <Text style={s.date}>{days[0] ? fmtDayLabel(days[0].date) : ""}</Text>
        <Text style={s.date}>
          {days[days.length - 1] ? fmtDayLabel(days[days.length - 1].date) : ""}
        </Text>
      </View>

      {/* The readout replaces the legend when a day is picked: naming the
          agents twice in the same spot is noise. */}
      {day ? (
        <Text style={s.readout}>
          <Text style={s.readoutDay}>{fmtDayLabel(day.date)}</Text>
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
  plotRow: { flexDirection: "row", gap: 6 },
  axis: { width: 44 },
  tick: {
    position: "absolute",
    right: 0,
    fontFamily: "JetBrainsMono",
    fontSize: 9,
    color: theme.colors.fgFaint,
  },
  dates: { flexDirection: "row", justifyContent: "space-between", paddingLeft: 50 },
  date: { fontSize: 10, color: theme.colors.fgFaint },
  legend: { flexDirection: "row", flexWrap: "wrap", gap: 12, paddingLeft: 50 },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 5 },
  swatch: { width: 8, height: 8, borderRadius: 2 },
  legendLabel: { fontSize: 11, color: theme.colors.fgMuted },
  readout: { paddingLeft: 50, fontSize: 11, color: theme.colors.fgMuted },
  readoutDay: { color: theme.colors.fg, fontWeight: "600" },
  hidden: { paddingLeft: 50, fontSize: 10.5, lineHeight: 15, color: theme.colors.fgFaint },
  empty: {
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
    backgroundColor: theme.colors.surfaceAlt,
  },
  emptyText: { fontSize: 12, color: theme.colors.fgFaint },
}));
