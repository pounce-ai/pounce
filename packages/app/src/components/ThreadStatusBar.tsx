import { Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ThreadUsage } from "../services/bridge";
// Shared with the activity dashboard so both read identically.
import { fmtCost, fmtTokens } from "../ui/format";

/** "claude-opus-4-8" → "opus 4.8"; "claude-haiku-4-5-20251001" → "haiku 4.5". */
export function shortModel(model: string): string {
  return model
    .replace(/^claude-/, "")
    .replace(/-\d{8}$/, "")
    .replace(/-(\d+)-(\d+)$/, " $1.$2")
    .replace(/-(\d+)$/, " $1");
}

/** "26% of 5h" — how much of a plan's rate-limit window an agent has consumed. */
function fmtRateLimit(rl: NonNullable<ThreadUsage["rateLimit"]>): string | null {
  if (rl.usedPercent == null) return null;
  const pct = `${Math.round(rl.usedPercent)}%`;
  if (!rl.windowMinutes) return `${pct} used`;
  const w =
    rl.windowMinutes >= 1440
      ? `${Math.round(rl.windowMinutes / 1440)}d`
      : rl.windowMinutes >= 60
        ? `${Math.round(rl.windowMinutes / 60)}h`
        : `${rl.windowMinutes}m`;
  return `${pct} of ${w}`;
}

/**
 * Static usage readout for the thread header: "79.4M · $61.03".
 *
 * Every figure here is the agent's own — we never price tokens ourselves, so a
 * thread simply shows no cost when its agent doesn't report one (Codex shows
 * its plan's rate-limit consumption instead). A leading "~" marks a cost that
 * covers only the turns Pounce drove, not the whole thread.
 */
export function ThreadUsageSummary({ usage }: { usage: ThreadUsage | null }) {
  if (!usage?.available || !usage.tokens) return null;
  const parts = [fmtTokens(usage.tokens.total)];
  if (usage.cost != null) {
    parts.push(`${usage.costComplete === false ? "~" : ""}${fmtCost(usage.cost)}`);
  } else if (usage.rateLimit) {
    const rl = fmtRateLimit(usage.rateLimit);
    if (rl) parts.push(rl);
  }
  return (
    <Text numberOfLines={1} style={s.summary}>
      {parts.join(" · ")}
    </Text>
  );
}

const s = StyleSheet.create((theme) => ({
  summary: { fontSize: 11, color: theme.colors.fgFaint },
}));
