import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import {
  Animated,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from "./animation";
import { AgentLogo, COLOR, fmtDuration } from "../ui";

function Dot({ delay }: { delay: number }) {
  const o = useSharedValue(0.3);
  useEffect(() => {
    o.value = withDelay(
      delay,
      withRepeat(withSequence(withTiming(1, { duration: 380 }), withTiming(0.3, { duration: 380 })), -1),
    );
  }, [o, delay]);
  const style = useAnimatedStyle(() => ({ opacity: o.value }));
  return <Animated.View style={[style, { width: 5, height: 5, borderRadius: 3, backgroundColor: COLOR.fgMuted }]} />;
}

/** Claude Code-style working verbs — one is picked per turn. */
const VERBS = [
  "Pouncing", "Transmuting", "Cogitating", "Levitating", "Percolating",
  "Brewing", "Noodling", "Marinating", "Simmering", "Conjuring",
  "Scheming", "Untangling", "Ruminating", "Tinkering", "Sautéing",
];

/**
 * A quiet "the agent is working" row for the tail of the timeline during a
 * turn. Mirrors Claude Code's TUI spinner: a whimsical verb picked per turn,
 * the ticking elapsed time since the user's message, and the current phase
 * ("Transmuting… (24s · thinking)").
 */
export function WorkingIndicator({
  agent,
  label = "Working…",
  since,
}: {
  agent?: string;
  label?: string;
  /** ISO timestamp of the turn's user message — drives the elapsed counter. */
  since?: string;
}) {
  const [verb] = useState(() => VERBS[Math.floor(Math.random() * VERBS.length)]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [since]);

  const elapsed = since ? Math.max(0, (now - Date.parse(since)) / 1000) : null;
  const phase = label.replace("…", "").toLowerCase();
  const detail =
    elapsed != null && Number.isFinite(elapsed)
      ? ` (${fmtDuration(elapsed)} · ${phase})`
      : "";
  return (
    <View className="flex-row items-center gap-2 py-1.5">
      {agent ? <AgentLogo agent={agent} size={14} /> : null}
      <Text className="text-[12px] text-fg-muted">
        {verb}…
        <Text className="text-fg-faint">{detail}</Text>
      </Text>
      <View className="flex-row items-center gap-1">
        <Dot delay={0} />
        <Dot delay={140} />
        <Dot delay={280} />
      </View>
    </View>
  );
}
