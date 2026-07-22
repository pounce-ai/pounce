import { Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ThreadUsage } from "../services/bridge";

/** 165_000_000 → "165M", 1_200_000 → "1.2M", 845_000 → "845K", 900 → "900". */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${m >= 100 ? Math.round(m) : m.toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return `${n}`;
}

/** "$6.20", "$0.05", or "<$0.01" for tiny non-zero costs. */
function fmtCost(cost: number): string {
  if (cost > 0 && cost < 0.01) return "<$0.01";
  return `$${cost.toFixed(2)}`;
}

/** "claude-opus-4-8" → "opus 4.8"; "claude-haiku-4-5-20251001" → "haiku 4.5". */
export function shortModel(model: string): string {
  return model
    .replace(/^claude-/, "")
    .replace(/-\d{8}$/, "")
    .replace(/-(\d+)-(\d+)$/, " $1.$2")
    .replace(/-(\d+)$/, " $1");
}

/**
 * Static usage readout for the thread header: "79.4M · $61.03" (a leading "~"
 * marks an incomplete cost estimate). Renders nothing until usage is available.
 */
export function ThreadUsageSummary({ usage }: { usage: ThreadUsage | null }) {
  if (!usage?.available || !usage.tokens) return null;
  const cost =
    usage.cost != null ? `${usage.costComplete === false ? "~" : ""}${fmtCost(usage.cost)}` : null;
  return (
    <Text numberOfLines={1} style={s.summary}>
      {fmtTokens(usage.tokens.total)}
      {cost ? ` · ${cost}` : ""}
    </Text>
  );
}

const s = StyleSheet.create((theme) => ({
  summary: { fontSize: 11, color: theme.colors.fgFaint },
}));
