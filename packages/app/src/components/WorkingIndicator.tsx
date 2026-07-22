import { useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
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
  // Animated.View: keep the static COLOR token — unistyles theme styles must not
  // mix into reanimated-managed styles.
  return <Animated.View style={[style, { width: 5, height: 5, borderRadius: 3, backgroundColor: COLOR.fgMuted }]} />;
}

/** Claude Code's full "working" gerund list (extracted verbatim from the CLI).
 *  Unlike the CLI — which re-rolls a random word every few seconds — we pick ONE
 *  deterministically per turn (see below) so every Pounce surface (phone,
 *  desktop) shows the SAME word for the same turn. A clock-rotated word couldn't
 *  stay in sync across devices. */
const VERBS = [
  "Accomplishing", "Actioning", "Actualizing", "Architecting", "Baking", "Beaming", "Beboppin'",
  "Befuddling", "Billowing", "Blanching", "Bloviating", "Boogieing", "Boondoggling", "Booping",
  "Bootstrapping", "Brewing", "Bunning", "Burrowing", "Calculating", "Canoodling", "Caramelizing",
  "Cascading", "Catapulting", "Cerebrating", "Channeling", "Channelling", "Choreographing",
  "Churning", "Clauding", "Coalescing", "Cogitating", "Combobulating", "Composing", "Computing",
  "Concocting", "Considering", "Contemplating", "Cooking", "Crafting", "Creating", "Crunching",
  "Crystallizing", "Cultivating", "Deciphering", "Deliberating", "Determining", "Dilly-dallying",
  "Discombobulating", "Doing", "Doodling", "Drizzling", "Ebbing", "Effecting", "Elucidating",
  "Embellishing", "Enchanting", "Envisioning", "Fermenting", "Fiddle-faddling", "Finagling",
  "Flibbertigibbeting", "Flowing", "Flummoxing", "Fluttering", "Forging", "Forming", "Frolicking",
  "Frosting", "Gallivanting", "Galloping", "Garnishing", "Generating", "Gesticulating",
  "Germinating", "Gitifying", "Grooving", "Gusting", "Harmonizing", "Hashing", "Hatching",
  "Herding", "Honking", "Hullaballooing", "Hyperspacing", "Ideating", "Imagining", "Improvising",
  "Incubating", "Inferring", "Infusing", "Ionizing", "Jitterbugging", "Julienning", "Kneading",
  "Leavening", "Levitating", "Lollygagging", "Manifesting", "Marinating", "Meandering",
  "Metamorphosing", "Misting", "Moonwalking", "Moseying", "Mulling", "Mustering", "Musing",
  "Nebulizing", "Nesting", "Newspapering", "Noodling", "Nucleating", "Orbiting", "Orchestrating",
  "Osmosing", "Perambulating", "Percolating", "Perusing", "Philosophising", "Photosynthesizing",
  "Pollinating", "Pondering", "Pontificating", "Pouncing", "Precipitating", "Prestidigitating",
  "Processing", "Proofing", "Propagating", "Puttering", "Puzzling", "Quantumizing",
  "Razzle-dazzling", "Razzmatazzing", "Recombobulating", "Reticulating", "Roosting", "Ruminating",
  "Scampering", "Schlepping", "Scurrying", "Seasoning", "Shenaniganing", "Shimmying", "Simmering",
  "Skedaddling", "Sketching", "Slithering", "Smooshing", "Sock-hopping", "Spelunking", "Spinning",
  "Sprouting", "Stewing", "Sublimating", "Swirling", "Swooping", "Symbioting", "Synthesizing",
  "Tempering", "Thinking", "Thundering", "Tinkering", "Tomfoolering", "Topsy-turvying",
  "Transfiguring", "Transmuting", "Twisting", "Undulating", "Unfurling", "Unravelling", "Vibing",
  "Waddling", "Wandering", "Warping", "Whatchamacalliting", "Whirlpooling", "Whirring",
  "Whisking", "Wibbling", "Working", "Wrangling", "Zesting", "Zigzagging",
];

/** Stable 32-bit hash of a string → same verb for the same turn on every client. */
function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Compact token count, Claude Code style: 4123 → "4.1k". */
function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}

/**
 * A quiet "the agent is working" row for the tail of the timeline during a turn.
 * Mirrors Claude Code's TUI spinner: a whimsical verb, ticking elapsed time, and
 * a live ↓ output-token count — e.g. "Transmuting… (1m 48s · ↓ 4.0k tokens)".
 * The verb is deterministic per turn so it matches across devices.
 */
export function WorkingIndicator({
  agent,
  since,
  tokens,
}: {
  agent?: string;
  /** ISO timestamp of the turn's user message — seeds the verb AND drives the timer. */
  since?: string;
  /** Estimated output tokens streamed so far this turn (from Session). */
  tokens?: number;
}) {
  const verb = useMemo(() => VERBS[hashStr(since ?? "") % VERBS.length], [since]);
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
      {agent ? <AgentLogo agent={agent} size={14} /> : null}
      <Text style={s.verb}>
        {verb}…
        <Text style={s.detail}>{detail}</Text>
      </Text>
      <View style={s.dots}>
        <Dot delay={0} />
        <Dot delay={140} />
        <Dot delay={280} />
      </View>
    </View>
  );
}

const s = StyleSheet.create((theme) => ({
  row: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 6 },
  verb: { fontSize: 12, color: theme.colors.fgMuted },
  detail: { color: theme.colors.fgFaint },
  dots: { flexDirection: "row", alignItems: "center", gap: 4 },
}));
