import { Pressable, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { AgentLogo, IS_DESKTOP } from "../ui";
import { agentLabel } from "../ui/tokens";
import { fmtTokens } from "../ui/format";
import type { AgentQuota } from "../services/bridge";

/** "in 4h 12m" / "in 2d" — how long until a window rolls over. */
function untilReset(iso: string | null, now: number): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `in ${hours}h ${mins % 60}m`;
  return `in ${Math.round(hours / 24)}d`;
}

/** A snapshot older than this reads as history, not status. */
const STALE_MS = 24 * 60 * 60_000;

/** Narrowest an agent card may get before it wraps instead. Sized to hold
 *  Claude's longest line — "2.3M/min · resets in 4h 9m" — on two lines. */
const AGENT_CARD_MIN = 232;

/** An agent the dashboard is counting that reported no plan at all — listed so
 *  the two cards agree, rather than silently dropped. */
function placeholder(agent: string): AgentQuota {
  return {
    hostId: "",
    agent,
    planType: null,
    note: "no plan detected",
    observedAt: null,
    windows: [],
  };
}

/**
 * Plan quota — the percentage of each rolling rate-limit window an agent has
 * consumed, with the time until it resets.
 *
 * This is the honest headline for subscription plans: a Codex Plus or Claude
 * Max seat has no per-token price, so "how much of my week is gone" is the real
 * question. Bars are colored by pressure, and a stale snapshot is dimmed rather
 * than presented as current — quota is only as fresh as the agent's last turn.
 *
 * Only Codex publishes a meter on disk. The others name their plan and say why
 * there's no bar; listing them without one is the point, because omitting an
 * agent entirely implies it isn't being used.
 */
export function QuotaCard({
  quotas,
  agents,
}: {
  quotas: readonly AgentQuota[];
  /** Every agent the dashboard is showing, so this card covers the same set as
   *  the per-agent table. An agent with no quota entry still gets a column. */
  agents?: readonly string[];
}) {
  const { theme } = useUnistyles();
  const router = useRouter();
  const now = Date.now();
  const byAgent = new Map(quotas.map((q) => [q.agent, q]));
  const order = agents?.length ? agents : quotas.map((q) => q.agent);
  const rows = order.map((agent) => byAgent.get(agent) ?? placeholder(agent));
  if (!rows.length) return null;
  return (
    <View style={s.section}>
      <Text style={s.title}>Plan usage</Text>
      {/* A card PER AGENT, not one card holding all of them. Each agent is a
          self-contained fact — its plan, its meter, its caveat — and boxing
          them together made four unrelated readings look like one reading with
          four parts. Desktop lays the cards side by side; a phone stacks them
          with the section's gap between. */}
      <View style={IS_DESKTOP ? s.columns : s.stack}>
        {rows.map((q) => {
          const stale = q.observedAt ? now - Date.parse(q.observedAt) > STALE_MS : false;
          return (
            <View
              key={`${q.hostId}:${q.agent}`}
              style={[s.agentCard, IS_DESKTOP ? s.column : null]}
            >
              <View style={s.agentRow}>
                <AgentLogo agent={q.agent} size={14} />
                <Text style={s.agentName}>{agentLabel(q.agent)}</Text>
                {q.planType ? <Text style={s.plan}>{q.planType}</Text> : null}
                {stale ? <Text style={s.stale}>stale</Text> : null}
              </View>
              {/* METERS FIRST, on every card. The reported windows are the
                headline — the one thing every agent that has them says in the
                same shape — so they sit directly under the name, and the
                supporting prose (a measurement of our own, or the reason there
                is no bar) follows. Claude used to lead with three lines of
                text and hide its bars below them, which made the one card with
                the most to say the hardest to read at a glance. */}
              {q.windows.map((w, i) => {
                const pct = Math.max(0, Math.min(100, w.usedPercent));
                // Warn before it bites, not after: amber past halfway, red near full.
                const fill =
                  pct >= 90
                    ? theme.colors.danger
                    : pct >= 60
                      ? theme.colors.warning
                      : theme.colors.accent;
                const reset = untilReset(w.resetsAt, now);
                return (
                  // Keyed by position as well as label: an agent can report two
                  // windows that share a name (Claude's weekly limits differ by
                  // model, and one of them arrives unscoped), and a duplicate
                  // key makes React reuse the wrong row.
                  <View key={`${i}:${w.label}`} style={[s.window, stale && s.dimmed]}>
                    <View style={s.windowHead}>
                      <Text style={s.windowLabel}>{w.label}</Text>
                      <Text style={s.windowPct}>{Math.round(pct)}%</Text>
                      {reset ? <Text style={s.windowReset}>resets {reset}</Text> : null}
                    </View>
                    <View style={s.track}>
                      <View style={[s.fill, { width: `${pct}%`, backgroundColor: fill }]} />
                    </View>
                  </View>
                );
              })}
              {/* Measured, not reported: no bar and no percentage, because the
                size of the window isn't knowable locally. What IS knowable —
                how much has gone in, how fast, when it rolls over — is worth
                more than a fabricated gauge. Below the reported bars, because
                it is the footnote to them and not the headline. */}
              {q.blocks?.current ? (
                // The block box is the TAP TARGET, not the whole card. It is
                // the only part of the card the breakdown explains, and only
                // Claude has one — so the other agents' cards read as
                // deliberately static rather than as identical cards that
                // mysteriously don't respond.
                <Pressable
                  onPress={() =>
                    // `key`, not `hostId`: that is the param desktop's
                    // `screenKey` remounts a pane on, so opening machine B's
                    // report replaces machine A's rather than inheriting its
                    // window selection and zoom.
                    router.push({ pathname: "/attribution", params: { key: q.hostId } })
                  }
                  accessibilityRole="button"
                  accessibilityLabel={`What filled this ${q.blocks.windowHours} hour window`}
                  style={({ pressed }) => [s.blockBox, pressed && s.pressed]}
                >
                  <View style={s.blockHead}>
                    <Text style={s.blockLabel}>This {q.blocks.windowHours}h window</Text>
                    <Text style={s.blockValue}>{fmtTokens(q.blocks.current.tokens)}</Text>
                    <Ionicons name="chevron-forward" size={12} color={theme.colors.fgFaint} />
                  </View>
                  <Text style={s.blockSub}>
                    {fmtTokens(q.blocks.current.tokensPerMin)}/min
                    {untilReset(q.blocks.current.resetsAt, now)
                      ? ` · resets ${untilReset(q.blocks.current.resetsAt, now)}`
                      : ""}
                  </Text>
                  <Text style={s.blockSub}>
                    busiest on record {fmtTokens(q.blocks.peak.tokens)}
                  </Text>
                </Pressable>
              ) : null}
              {/* Agents that name a plan but publish no meter say so, rather than
                being left out — an absent row reads as "unused", which is a
                different and wrong claim. */}
              {!q.windows.length && q.note ? <Text style={s.note}>{q.note}</Text> : null}
            </View>
          );
        })}
      </View>
    </View>
  );
}

const s = StyleSheet.create((theme) => ({
  // A titled section now, not a card: the cards are the agents inside it.
  section: { gap: 10 },
  title: {
    fontSize: 11,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    color: theme.colors.fgFaint,
  },
  agentCard: {
    gap: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
    padding: 14,
  },
  // One row of equal cards. They used to be borderless blocks sharing a single
  // card; now each carries its own box, which is what makes four agents read as
  // four readings instead of one with four parts.
  // Wrap, don't squeeze. Six agents in one row gave each a sixth of the width,
  // which crushed Claude's block until "busiest on record" fell out of its own
  // card. A card that won't fit belongs on the next line.
  // `stretch`, not `flex-start`: agents carry different amounts of detail —
  // Claude has a measured window, Cursor has one line — and letting each card
  // size to its own content left a stubby Cursor beside a tall Claude. Stretch
  // matches every card in a row to the tallest in THAT row (which is per flex
  // line, so a wrapped row still sizes to its own contents).
  columns: { flexDirection: "row", flexWrap: "wrap", alignItems: "stretch", gap: 10 },
  // `minWidth` is the whole point — it used to be 0, which is what let them
  // shrink without limit. `flexGrow` then shares the leftover so a row of two
  // doesn't leave half the card width empty.
  column: { flexBasis: AGENT_CARD_MIN, flexGrow: 1, minWidth: AGENT_CARD_MIN },
  // The phone stacks them. This used to be no style at all, which left the
  // blocks touching: the `gap` inside an agent doesn't separate one from the
  // next.
  stack: { gap: 10 },
  agentRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  agentName: { fontSize: 14, color: theme.colors.fg },
  plan: {
    borderRadius: 999,
    backgroundColor: theme.colors.accentSoft,
    paddingHorizontal: 7,
    paddingVertical: 1,
    fontSize: 10,
    fontWeight: "600",
    textTransform: "uppercase",
    color: theme.colors.accent,
  },
  stale: { marginLeft: "auto", fontSize: 10, color: theme.colors.fgFaint },
  note: { fontSize: 11.5, color: theme.colors.fgFaint },
  blockBox: { gap: 2 },
  pressed: { opacity: 0.7 },
  blockHead: { flexDirection: "row", alignItems: "baseline", gap: 6 },
  blockLabel: { fontSize: 12, color: theme.colors.fgMuted },
  blockValue: {
    marginLeft: "auto",
    fontFamily: "JetBrainsMono",
    fontSize: 12,
    color: theme.colors.fg,
  },
  blockSub: { fontSize: 11, color: theme.colors.fgFaint },
  dimmed: { opacity: 0.55 },
  window: { gap: 4 },
  windowHead: { flexDirection: "row", alignItems: "baseline", gap: 6 },
  windowLabel: { fontSize: 12, color: theme.colors.fgMuted },
  windowPct: { fontFamily: "JetBrainsMono", fontSize: 12, color: theme.colors.fg },
  windowReset: { marginLeft: "auto", fontSize: 11, color: theme.colors.fgFaint },
  track: { height: 5, borderRadius: 999, backgroundColor: theme.colors.border, overflow: "hidden" },
  fill: { height: 5, borderRadius: 999 },
}));
