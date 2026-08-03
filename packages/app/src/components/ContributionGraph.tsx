import { useEffect, useMemo, useRef } from "react";
import { Pressable, ScrollView, Text, View, useColorScheme } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import Svg, { Rect } from "react-native-svg";
import type { HeatDay } from "../services/activity";
import { monthOf } from "../ui/format";

/**
 * Activity heatmap — a year of days as a week-per-column grid, GitHub-style.
 *
 * ONE <Svg> of <Rect>s rather than ~370 <View>s: each View is a native node and
 * a year's worth would dominate the screen's view tree. Taps resolve
 * arithmetically off the touch point (the grid is uniform), so there are no
 * per-cell responders either.
 */

export const CELL = 11;
export const GAP = 2;
const STEP = CELL + GAP;
/** Ceiling for a filled cell. Without it, `fillWidth` over a handful of columns
 *  grows each cell without bound and the grid reads as slabs, not a calendar. */
const MAX_STEP = 18;
const ROWS = 7;

/**
 * Single-hue sequential ramp on the brand accent, monotone in lightness. Dark
 * mode gets its OWN steps (it is not the light ramp reversed — reversing would
 * put the darkest ink on the darkest background). Cell gaps and the tap-to-read
 * detail row carry the same information for anyone who can't separate the steps.
 */
const RAMP = {
  light: ["#ebebf0", "#e2ddfc", "#aca0f6", "#7c6ff0", "#4634c9"],
  // The empty step has to sit ABOVE the card it's drawn on (surfaceAlt, #1b1b22
  // in dark) or the grid disappears through a quiet stretch and the year reads
  // as a few floating squares instead of a calendar.
  dark: ["#2b2b35", "#332e63", "#5546a8", "#7c6ff0", "#b3a7ff"],
} as const;

/** Column index → the month it starts, for the labels above the grid. */
function monthLabels(days: readonly HeatDay[], leadingBlanks: number) {
  const out: { col: number; label: string }[] = [];
  let last = "";
  for (let i = 0; i < days.length; i++) {
    const col = Math.floor((i + leadingBlanks) / ROWS);
    const m = monthOf(days[i].date);
    if (m !== last) {
      // Skip a label that would collide with the previous one.
      if (!out.length || col - out[out.length - 1].col >= 3) out.push({ col, label: m });
      last = m;
    }
  }
  return out;
}

export function ContributionGraph({
  days,
  selected,
  onSelectDay,
  compact,
  fillWidth,
  rows = ROWS,
}: {
  /** Chronological, gap-free, quantized (see services/activity). */
  days: readonly HeatDay[];
  selected?: string | null;
  onSelectDay?: (date: string) => void;
  /** Share-card mode: no scroll, no labels — the caller sizes the window. */
  compact?: boolean;
  /**
   * Grid height in cells. 7 is the calendar — a column per week, a row per
   * weekday, which is what a year wants. Pass 1 for a short window: a fortnight
   * as a 7-row calendar is two lonely columns, whereas a single strip of days
   * reads immediately and fills the width it is given.
   */
  rows?: number;
  /** Grow the cells to fill this width instead of using the fixed phone size.
   *  A 53-week grid at 11pt cells is ~690pt wide; in a desktop card twice that,
   *  it sits in the left half with dead space beside it. Never shrinks below
   *  the phone size — on a narrow card the horizontal scroll still applies. */
  fillWidth?: number;
}) {
  const scheme = useColorScheme();
  const ramp = RAMP[scheme === "light" ? "light" : "dark"];
  const scrollRef = useRef<ScrollView>(null);

  // Start each column on a Sunday so weekday rows line up like a calendar.
  // Meaningless for a single strip, where a column IS a day.
  const leadingBlanks = useMemo(() => {
    if (!days.length || rows === 1) return 0;
    const [y, m, d] = days[0].date.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  }, [days, rows]);

  const cols = Math.ceil((days.length + leadingBlanks) / rows);
  // Fill the width when asked, but never past MAX_STEP: a short window has few
  // columns, and unbounded growth turns a fortnight into a row of slabs.
  const step =
    fillWidth && cols
      ? Math.min(MAX_STEP, Math.max(STEP, Math.floor((fillWidth + GAP) / cols)))
      : STEP;
  const cell = step - GAP;
  const width = Math.max(1, cols * step - GAP);
  const height = rows * step - GAP;
  // Month labels describe a week-per-column calendar; a day strip has no months
  // to mark, and the caller titles the window instead.
  const labels = useMemo(
    () => (compact || rows === 1 ? [] : monthLabels(days, leadingBlanks)),
    [compact, days, leadingBlanks, rows],
  );

  // Open on today (the right edge) — the recent weeks are what people look at.
  useEffect(() => {
    if (compact) return;
    const t = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: false }), 0);
    return () => clearTimeout(t);
  }, [compact, width]);

  const grid = (
    <Pressable
      disabled={!onSelectDay}
      onPress={(e) => {
        const { locationX, locationY } = e.nativeEvent;
        const col = Math.floor(locationX / step);
        const row = Math.floor(locationY / step);
        if (row < 0 || row >= rows || col < 0) return;
        const idx = col * rows + row - leadingBlanks;
        const hit = days[idx];
        if (hit) onSelectDay?.(hit.date);
      }}
    >
      {/* pointerEvents="none": RNSVG's view swallows the click on macOS, so the
          Pressable above never sees it and selecting a day did nothing. The
          grid is decorative — hit-testing is arithmetic on locationX/Y, not on
          the rects — so it has no reason to take events. */}
      <Svg width={width} height={height} pointerEvents="none">
        {days.map((d, i) => {
          const slot = i + leadingBlanks;
          return (
            <Rect
              key={d.date}
              x={Math.floor(slot / rows) * step}
              y={(slot % rows) * step}
              width={cell}
              height={cell}
              rx={2}
              fill={ramp[d.level]}
              // Selection reads as a ring, so it survives on any ramp step.
              stroke={d.date === selected ? ramp[4] : undefined}
              strokeWidth={d.date === selected ? 1.5 : 0}
            />
          );
        })}
      </Svg>
    </Pressable>
  );

  if (compact) return grid;

  return (
    <View style={s.wrap}>
      <ScrollView
        ref={scrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={s.scrollContent}
      >
        <View>
          <View style={[s.labelRow, { width }]}>
            {labels.map((l) => (
              <Text key={`${l.col}:${l.label}`} style={[s.monthLabel, { left: l.col * step }]}>
                {l.label}
              </Text>
            ))}
          </View>
          {grid}
        </View>
      </ScrollView>
      <View style={s.legend}>
        <Text style={s.legendText}>Less</Text>
        {ramp.map((c, i) => (
          <View key={i} style={[s.swatch, { backgroundColor: c }]} />
        ))}
        <Text style={s.legendText}>More</Text>
      </View>
    </View>
  );
}

const s = StyleSheet.create((theme) => ({
  wrap: { gap: 8 },
  scrollContent: { paddingRight: 12 },
  // Absolute labels: a month starts at an arbitrary column, so flow layout
  // can't place them without inventing spacers.
  labelRow: { height: 14 },
  monthLabel: { position: "absolute", top: 0, fontSize: 10, color: theme.colors.fgFaint },
  legend: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 3 },
  legendText: { marginHorizontal: 3, fontSize: 10, color: theme.colors.fgFaint },
  swatch: { width: 9, height: 9, borderRadius: 2 },
}));
