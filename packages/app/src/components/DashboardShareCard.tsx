import { Text, View } from "react-native";
import type { ActivityTotals, HeatDay, Period, Streaks } from "../services/activity";
import { ContributionGraph } from "./ContributionGraph";
import { fmtCost, fmtCount, fmtTokens } from "../ui/format";

/** 4:5 — the aspect ratio that fills a phone feed post. Captured at
 *  pixelRatio 3 → 1080×1350. */
export const SHARE_CARD_WIDTH = 360;
export const SHARE_CARD_HEIGHT = 450;

/** Weeks of heatmap that fit the card's width at the graph's cell size. */
const SHARE_WEEKS = 26;

const PERIOD_LABEL: Record<Period, string> = {
  week: "this week",
  month: "this month",
  year: "this year",
};

/**
 * The shareable image. Fixed size and deliberately dark in BOTH schemes — the
 * capture has to look like one designed artifact wherever it's posted, not like
 * a screenshot of whatever theme the user happens to run.
 *
 * Rendered offscreen by the Dashboard only while sharing; nothing here is
 * interactive, so styles are plain literals rather than themed tokens.
 */
export function DashboardShareCard({
  days,
  totals,
  streak,
  period,
  costComplete,
}: {
  days: readonly HeatDay[];
  totals: Omit<ActivityTotals, "costComplete">;
  streak: Streaks;
  period: Period;
  costComplete: boolean;
}) {
  const window = days.slice(-SHARE_WEEKS * 7);
  const first = window[0]?.date;
  const last = window[window.length - 1]?.date;
  return (
    <View style={s.card}>
      <View style={s.header}>
        <Text style={s.brand}>Pounce</Text>
        <Text style={s.period}>{PERIOD_LABEL[period]}</Text>
      </View>

      {/* Tokens are the headline: they're the agent's own number and always
        exist. A dollar figure is shown only when an agent actually reported
        one, so the card can't imply a spend nobody measured. */}
      <Text style={s.hero}>{fmtTokens(totals.tokens)}</Text>
      <Text style={s.heroLabel}>tokens driving coding agents</Text>

      <View style={s.statRow}>
        <Stat value={fmtCount(totals.sessions)} label="sessions" />
        <Stat value={fmtCount(totals.messages)} label="messages" />
        {totals.cost == null ? null : (
          <Stat
            value={`${costComplete ? "" : "~"}${fmtCost(totals.cost)}`}
            label={costComplete ? "spend" : "spend (partial)"}
          />
        )}
      </View>

      <View style={s.graphWrap}>
        <ContributionGraph days={window} compact />
      </View>

      <View style={s.footer}>
        <Text style={s.streak}>
          🔥 {streak.current}-day streak · {streak.longest} best
        </Text>
        <Text style={s.range}>{first && last ? `${first} → ${last}` : ""}</Text>
      </View>
      <Text style={s.url}>use-pounce.com</Text>
    </View>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <View style={s.stat}>
      <Text style={s.statValue}>{value}</Text>
      <Text style={s.statLabel}>{label}</Text>
    </View>
  );
}

const BG = "#0b0b0f";
const ACCENT = "#7c6ff0";
const FG = "#ececf1";
const FAINT = "#62626d";

const s = {
  card: {
    width: SHARE_CARD_WIDTH,
    height: SHARE_CARD_HEIGHT,
    backgroundColor: BG,
    borderWidth: 1,
    borderColor: "rgba(124, 111, 240, 0.45)",
    borderRadius: 20,
    paddingHorizontal: 22,
    paddingVertical: 24,
  },
  header: { flexDirection: "row", alignItems: "baseline", gap: 8 },
  brand: { fontSize: 20, fontWeight: "700", color: FG },
  period: { fontSize: 13, color: FAINT },
  hero: {
    marginTop: 26,
    fontFamily: "JetBrainsMono",
    fontSize: 46,
    fontWeight: "700",
    color: ACCENT,
  },
  heroLabel: { marginTop: 2, fontSize: 13, color: FAINT },
  statRow: { flexDirection: "row", marginTop: 24, gap: 18 },
  stat: { gap: 2 },
  statValue: { fontFamily: "JetBrainsMono", fontSize: 19, fontWeight: "600", color: FG },
  statLabel: {
    fontSize: 10,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.6,
    color: FAINT,
  },
  graphWrap: { marginTop: 26 },
  footer: { marginTop: "auto", gap: 2 },
  streak: { fontSize: 13, fontWeight: "600", color: FG },
  range: { fontFamily: "JetBrainsMono", fontSize: 10, color: FAINT },
  url: { marginTop: 10, fontSize: 11, fontWeight: "600", color: ACCENT },
} as const;
