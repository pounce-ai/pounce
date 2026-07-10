import { useState } from "react";
import { Pressable, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { cn, COLOR } from "../ui";

/** A marked message, resolved against the current event list. */
export interface Marker {
  id: string;
  /** Index into the timeline's `events` array (for scrollToIndex). */
  index: number;
  type: "user_message" | "assistant_message";
  text: string;
  ts: string;
}

/** Minimum px between dot centers before neighbors collapse into one. */
const MIN_SPACING = 14;
/** Rail space reserved at the bottom for the jump-list button. */
const LIST_BUTTON_ZONE = 40;

interface Dot {
  marker: Marker;
  top: number;
  /** True when nearby markers collapsed into this dot (renders larger). */
  cluster: boolean;
}

/** Slim overlay rail on the thread's right edge — one dot per marker,
 *  positioned proportionally by event index (row heights are estimated, so
 *  pixel offsets would drift as rows measure in). Tap a dot to jump. */
export function MarkerRail({
  markers,
  total,
  onJump,
  onOpenList,
}: {
  markers: Marker[];
  /** Total event count — the denominator for proportional placement. */
  total: number;
  onJump: (index: number) => void;
  onOpenList: () => void;
}) {
  const [height, setHeight] = useState(0);
  if (!markers.length) return null;

  const usable = Math.max(height - LIST_BUTTON_ZONE, 0);
  const dots: Dot[] = [];
  for (const marker of markers) {
    const top = (marker.index / Math.max(total - 1, 1)) * usable;
    const prev = dots[dots.length - 1];
    // Too close to the previous dot → fold into it; it keeps its first member
    // as the jump target and grows slightly to signal the cluster.
    if (prev && top - prev.top < MIN_SPACING) prev.cluster = true;
    else dots.push({ marker, top, cluster: false });
  }

  return (
    <View
      pointerEvents="box-none"
      onLayout={(e) => setHeight(e.nativeEvent.layout.height)}
      style={{ position: "absolute", right: 0, top: 8, bottom: 8, width: 22 }}
    >
      {height > 0
        ? dots.map((d) => (
            <Pressable
              key={d.marker.id}
              onPress={() => onJump(d.marker.index)}
              hitSlop={{ top: 6, bottom: 6, left: 12, right: 6 }}
              style={{ position: "absolute", top: d.top, right: 8 }}
            >
              <View
                className={cn(
                  "rounded-full",
                  d.cluster ? "h-2 w-2" : "h-1.5 w-1.5",
                  d.marker.type === "user_message"
                    ? "bg-accent"
                    : "border border-fg-muted",
                )}
              />
            </Pressable>
          ))
        : null}
      <Pressable
        onPress={onOpenList}
        hitSlop={8}
        className="active:opacity-60 absolute bottom-0 right-0.5 h-7 w-7 items-center justify-center rounded-full border border-border bg-surface-alt"
      >
        <Ionicons name="list" size={14} color={COLOR.fgMuted} />
      </Pressable>
    </View>
  );
}
