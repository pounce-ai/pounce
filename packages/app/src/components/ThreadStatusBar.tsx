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
 * Tokens are always the agent's own. Dollars carry their provenance: a bare
 * figure is what the agent reported, a leading "~" means it covers only the
 * turns Pounce drove, and a trailing "est." means nobody reported one so it was
 * priced at public list rates instead (see ThreadUsage.costSource). A thread
 * with no source at all shows no cost — Codex shows its plan's rate-limit
 * consumption instead, which for a subscription is the meaningful number.
 */
export function ThreadUsageSummary({ usage }: { usage: ThreadUsage | null }) {
  if (!usage?.available || !usage.tokens) return null;
  const parts = [fmtTokens(usage.tokens.total)];
  if (usage.cost != null) {
    const estimated = usage.costSource === "ccusage-est";
    const approx = estimated || usage.costComplete === false;
    parts.push(`${approx ? "~" : ""}${fmtCost(usage.cost)}${estimated ? " est." : ""}`);
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
