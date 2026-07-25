import { Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { AgentLogo } from "../ui";
import { agentLabel } from "../ui/tokens";
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

/**
 * Plan quota — the percentage of each rolling rate-limit window an agent has
 * consumed, with the time until it resets.
 *
 * This is the honest headline for subscription plans: a Codex Plus or Claude
 * Max seat has no per-token price, so "how much of my week is gone" is the real
 * question. Bars are colored by pressure, and a stale snapshot is dimmed rather
 * than presented as current — quota is only as fresh as the agent's last turn.
 */
export function QuotaCard({ quotas }: { quotas: readonly AgentQuota[] }) {
  const { theme } = useUnistyles();
  const now = Date.now();
  if (!quotas.length) return null;
  return (
    <View style={s.card}>
      <Text style={s.title}>Plan usage</Text>
      {quotas.map((q) => {
        const stale = q.observedAt ? now - Date.parse(q.observedAt) > STALE_MS : false;
        return (
          <View key={`${q.hostId}:${q.agent}`} style={s.agentBlock}>
            <View style={s.agentRow}>
              <AgentLogo agent={q.agent} size={14} />
              <Text style={s.agentName}>{agentLabel(q.agent)}</Text>
              {q.planType ? <Text style={s.plan}>{q.planType}</Text> : null}
              {stale ? <Text style={s.stale}>stale</Text> : null}
            </View>
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
  dimmed: { opacity: 0.55 },
  window: { gap: 4 },
  windowHead: { flexDirection: "row", alignItems: "baseline", gap: 6 },
  windowLabel: { fontSize: 12, color: theme.colors.fgMuted },
  windowPct: { fontFamily: "JetBrainsMono", fontSize: 12, color: theme.colors.fg },
  windowReset: { marginLeft: "auto", fontSize: 11, color: theme.colors.fgFaint },
  track: { height: 5, borderRadius: 999, backgroundColor: theme.colors.border, overflow: "hidden" },
  fill: { height: 5, borderRadius: 999 },
}));
