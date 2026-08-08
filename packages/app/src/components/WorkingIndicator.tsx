import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { fmtDuration } from "../ui";
import { ShimmerLabel } from "./ShimmerLabel";

/** Compact token count: 4123 → "4.1k". */
function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}

/**
 * A quiet "the agent is working" row for the tail of the timeline during a turn:
 * a shimmering "Working", ticking elapsed time, and a live output-token count —
 * "Working (1m 48s · ↓ 4.0k tokens)".
 *
 * The same shimmer the thread uses while it loads, so the two waiting states in
 * this app read as one idea rather than two inventions.
 */
export function WorkingIndicator({
  since,
  tokens,
}: {
  /** ISO timestamp of the turn's user message — drives the timer. */
  since?: string;
  /** Estimated output tokens streamed so far this turn (from Session). */
  tokens?: number;
}) {
  // Hold the indicator back briefly so it doesn't compete with the sent
  // message's entrance — instant replies never flash it at all.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    setSettled(false);
    const t = setTimeout(() => setSettled(true), 450);
    return () => clearTimeout(t);
  }, [since]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [since]);

  const elapsed = since ? Math.max(0, (now - Date.parse(since)) / 1000) : null;
  const detail =
    elapsed != null && Number.isFinite(elapsed)
      ? ` (${fmtDuration(elapsed)}${tokens && tokens > 0 ? ` · ↓ ${fmtTokens(tokens)} tokens` : ""})`
      : "";
  if (!settled) return null;
  return (
    <View style={s.row}>
      {/* One word, shimmering. What it replaced: a per-agent logo, a randomly
          chosen whimsical verb ("Discombobulating…"), and three bouncing dots —
          three separate things all saying the same thing, in a spot the eye
          returns to on every turn. The verb was the worst of it: it's Claude
          Code's voice, shown above whichever agent is actually running, and a
          different word each turn makes a fixed status read as new information.
          The elapsed time and token count stay, because those DO change. */}
      <ShimmerLabel text="Working" width={110} />
      {detail ? <Text style={s.detail}>{detail.replace(/^ /, "")}</Text> : null}
    </View>
  );
}

const s = StyleSheet.create((theme) => ({
  row: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 6 },
  detail: { fontSize: 12, color: theme.colors.fgFaint },
}));
