/**
 * How long this turn has been running, and roughly how much has come back:
 * "1m 48s · ↓ 4.0k".
 *
 * The WORD is gone — the agent's own mark on the model pill beside this morphs
 * into its thinking animation, which says "working" better than the label did
 * and says WHO is working at the same time. What stays is the part that
 * actually changes while you wait, which is the only reason to look twice.
 *
 * Lives in the composer's pill row rather than in the transcript, so a turn
 * costs no line of the conversation.
 */
import { useEffect, useState } from "react";
import { Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { fmtDuration } from "../ui";

/** Compact token count: 4123 → "4.1k". */
function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}

export function TurnMeter({
  since,
  tokens,
}: {
  /** ISO timestamp of the turn's user message — drives the timer. */
  since?: string;
  /** Estimated output tokens streamed so far this turn. */
  tokens?: number;
}) {
  // Held back briefly so it doesn't compete with the sent message's entrance;
  // instant replies never flash it at all.
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

  if (!settled || !since) return null;
  const elapsed = Math.max(0, (now - Date.parse(since)) / 1000);
  if (!Number.isFinite(elapsed)) return null;

  return (
    <Text numberOfLines={1} style={s.meter}>
      {fmtDuration(elapsed)}
      {tokens && tokens > 0 ? ` · ↓ ${fmtTokens(tokens)}` : ""}
    </Text>
  );
}

const s = StyleSheet.create((theme) => ({
  /* Reference, not a control: it sits between two pills and must read as
     quieter than both, or the row becomes three things competing. */
  meter: { fontSize: 12, color: theme.colors.fgFaint },
}));
