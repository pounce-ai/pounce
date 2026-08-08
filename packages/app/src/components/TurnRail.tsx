/**
 * A tick per turn, down the edge of the transcript.
 *
 * The same data the marker sheet lists, drawn as a rail instead of hidden
 * behind a button. That difference is the point: the sheet answers "take me to
 * a turn" only if you already remember it exists, while the rail also answers
 * "how long is this thread" and "where am I in it" without being asked. The
 * sheet stays for curation — this is for navigation.
 *
 * Ticks are spaced EVENLY, not by scroll offset. The transcript is virtualized
 * and genuinely doesn't know the height of rows it hasn't measured, so a true
 * proportional minimap isn't available to it. Even spacing is what most
 * minimaps do regardless, and it reads correctly; it just won't line up with
 * the scrollbar on a thread whose turns differ wildly in length.
 *
 * Desktop-only in practice — the preview is a hover, and phones have no
 * pointer. The caller gates it.
 */
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { parseUserMessage } from "@pounce/transcript";
import type { Marker } from "./MarkerSheet";

/** Rail width. Wide enough to hit, narrow enough to ignore. */
const RAIL_W = 16;
/** Ticks never crowd closer than this, so a 200-turn thread stays readable. */
const MIN_GAP = 5;
const MAX_GAP = 14;

/** First line of a marker, cleaned of the command scaffolding a user message
 *  carries, for the hover preview. */
function previewOf(m: Marker, agent?: string): string {
  const text = m.type === "user_message" ? parseUserMessage(m.text, agent).text : m.text;
  return (
    text
      .trim()
      .split("\n")
      .find((l) => l.trim().length > 0) ?? ""
  );
}

export function TurnRail({
  markers,
  agent,
  /** Topmost visible row index in the timeline — resolves to the turn you're in. */
  visibleIndex,
  onJump,
}: {
  markers: Marker[];
  agent?: string;
  visibleIndex?: number;
  onJump: (index: number) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [height, setHeight] = useState(0);

  /** The turn you're currently inside: the last one at or above the top of the
   *  viewport. Not the nearest — scrolling into a long reply should keep
   *  pointing at the turn that produced it, not jump ahead to the next. */
  const current = useMemo(() => {
    if (visibleIndex == null) return -1;
    let at = -1;
    for (let i = 0; i < markers.length; i++) {
      if (markers[i].index <= visibleIndex) at = i;
      else break;
    }
    return at;
  }, [markers, visibleIndex]);

  if (markers.length < 2) return null;

  // Fit the ticks to the rail, then stop growing: a four-turn thread shouldn't
  // scatter four ticks down 800pt of nothing.
  const gap = Math.max(MIN_GAP, Math.min(MAX_GAP, height / Math.max(1, markers.length)));
  const top = Math.max(0, (height - gap * markers.length) / 2);

  return (
    <View style={s.rail} onLayout={(e) => setHeight(e.nativeEvent.layout.height)}>
      {markers.map((m, i) => {
        const on = i === current;
        const near = hover === i;
        return (
          <Pressable
            key={m.id}
            onPress={() => onJump(m.index)}
            // Hover is the whole reason this beats the sheet: you can scan a
            // thread without committing to a jump. Cast because these props are
            // macOS-only and absent from the mobile RN types this package is
            // built against.
            {...({
              onMouseEnter: () => setHover(i),
              onMouseLeave: () => setHover((h) => (h === i ? null : h)),
            } as Record<string, unknown>)}
            style={[s.hit, { top: top + i * gap, height: gap }]}
          >
            <View
              style={[
                s.tick,
                // A user turn is the spine of the thread; an assistant marker is
                // something you flagged inside one. Different lengths so the
                // rhythm of the thread is legible without colour.
                m.type === "user_message" ? s.tickTurn : s.tickNote,
                on && s.tickOn,
                near && s.tickHover,
              ]}
            />
          </Pressable>
        );
      })}

      {hover != null && markers[hover] ? (
        <View
          style={[s.preview, { top: Math.max(0, top + hover * gap - 12) }]}
          pointerEvents="none"
        >
          <Text numberOfLines={3} style={s.previewText}>
            {previewOf(markers[hover], agent)}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create((theme) => ({
  rail: { width: RAIL_W, alignItems: "center" },
  // Absolute so the ticks can be spaced arithmetically rather than by flex —
  // the gap is computed from the measured height, and layout shouldn't fight it.
  hit: { position: "absolute", width: RAIL_W, alignItems: "center", justifyContent: "center" },
  tick: { height: 1.5, borderRadius: 1, backgroundColor: theme.colors.fgFaint, opacity: 0.5 },
  tickTurn: { width: 11 },
  tickNote: { width: 6 },
  tickOn: { backgroundColor: theme.colors.accent, opacity: 1, height: 2 },
  tickHover: { opacity: 1 },
  preview: {
    position: "absolute",
    left: RAIL_W + 6,
    width: 240,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.bgElevated,
    paddingHorizontal: 10,
    paddingVertical: 7,
    // Floats over the transcript, so it needs a shadow to read as above it.
    shadowColor: "#000",
    shadowOpacity: 0.3,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    zIndex: 10,
  },
  previewText: { fontSize: 11.5, lineHeight: 16, color: theme.colors.fgMuted },
}));
