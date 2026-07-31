import { Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
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
  const now = Date.now();
  const byAgent = new Map(quotas.map((q) => [q.agent, q]));
  const order = agents?.length ? agents : quotas.map((q) => q.agent);
  const rows = order.map((agent) => byAgent.get(agent) ?? placeholder(agent));
  if (!rows.length) return null;
  return (
    <View style={s.card}>
      <Text style={s.title}>Plan usage</Text>
      {/* Desktop lays the agents side by side: each is a short, self-contained
          block, and stacking four of them turned one card into a column the
          height of the window. */}
      <View style={IS_DESKTOP ? s.columns : undefined}>
        {rows.map((q) => {
          const stale = q.observedAt ? now - Date.parse(q.observedAt) > STALE_MS : false;
          return (
            <View key={`${q.hostId}:${q.agent}`} style={[s.agentBlock, IS_DESKTOP && s.column]}>
              <View style={s.agentRow}>
                <AgentLogo agent={q.agent} size={14} />
                <Text style={s.agentName}>{agentLabel(q.agent)}</Text>
                {q.planType ? <Text style={s.plan}>{q.planType}</Text> : null}
                {stale ? <Text style={s.stale}>stale</Text> : null}
              </View>
              {/* Agents that name a plan but publish no meter say so, rather than
                being left out — an absent row reads as "unused", which is a
                different and wrong claim. */}
              {!q.windows.length && q.note ? <Text style={s.note}>{q.note}</Text> : null}
              {/* Measured, not reported: no bar and no percentage, because the
                size of the window isn't knowable locally. What IS knowable —
                how much has gone in, how fast, when it rolls over — is worth
                more than a fabricated gauge. */}
              {q.blocks?.current ? (
                <View style={s.blockBox}>
                  <View style={s.blockHead}>
                    <Text style={s.blockLabel}>This {q.blocks.windowHours}h window</Text>
                    <Text style={s.blockValue}>{fmtTokens(q.blocks.current.tokens)}</Text>
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
                </View>
              ) : null}
              {q.windows.map((w) => {
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
                  <View key={w.label} style={[s.window, stale && s.dimmed]}>
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
            </View>
          );
        })}
      </View>
    </View>
  );
}

const s = StyleSheet.create((theme) => ({
  card: {
    gap: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
    padding: 14,
  },
  title: {
    fontSize: 11,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    color: theme.colors.fgFaint,
  },
  agentBlock: { gap: 8 },
  // One row of equal columns, divided rather than boxed — a border per agent
  // would read as four cards inside a card.
  columns: { flexDirection: "row", alignItems: "flex-start", gap: 18 },
  column: { flex: 1, minWidth: 0 },
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
