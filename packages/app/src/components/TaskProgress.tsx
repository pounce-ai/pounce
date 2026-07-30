import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { PounceIcon } from "../ui/native/Icon";
import { Animated, FadeIn, FadeOut } from "./animation";
import { TodoRows } from "./TodoCard";
import { type TaskListState, taskProgress } from "./taskEvents";

/**
 * The thread's live task list, pinned above the composer so it stays on screen
 * while the timeline scrolls — the answer to "what is it doing and how far in?"
 * without hunting for the newest TodoWrite row.
 *
 * Collapsed by default (one line: a progress bar, n/m, and the active item);
 * tap to see the whole checklist. Session decides when to show it at all.
 */
export function TaskProgressBar({ state, running }: { state: TaskListState; running: boolean }) {
  const { theme } = useUnistyles();
  const [open, setOpen] = useState(false);
  const p = taskProgress(state.items);
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
  const allDone = p.done === p.total;
  return (
    <Animated.View
      entering={FadeIn.duration(180)}
      exiting={FadeOut.duration(120)}
      style={ANIM.wrap}
    >
      <Pressable onPress={() => setOpen((v) => !v)} style={s.card}>
        <View style={s.header}>
          <PounceIcon
            name={allDone ? "checkmark-circle" : "checkbox"}
            size={14}
            color={allDone ? theme.colors.success : theme.colors.accent}
          />
          <Text style={s.count}>
            {p.done}/{p.total}
          </Text>
          <Text numberOfLines={1} style={s.active}>
            {allDone ? "All tasks done" : (p.activeLabel ?? "Tasks")}
            {running && !allDone ? "…" : ""}
          </Text>
          <PounceIcon
            name={open ? "chevron-down" : "chevron-up"}
            size={13}
            color={theme.colors.fgFaint}
          />
        </View>
        <View style={s.track}>
          <View style={[s.fill, { width: `${pct}%` }, allDone && s.fillDone]} />
        </View>
        {open ? (
          // Bounded: a 20-item plan must not push the composer off screen.
          <ScrollView style={s.list} contentContainerStyle={s.listContent}>
            <TodoRows items={state.items} compact />
          </ScrollView>
        ) : null}
      </Pressable>
    </Animated.View>
  );
}

const ACCENT_BORDER = "rgba(124, 111, 240, 0.4)";

/** Plain style for the reanimated-managed view — unistyles theme styles must not
 *  mix into styles reanimated owns (same reason WorkingIndicator uses COLOR). */
const ANIM = { wrap: { marginHorizontal: 12, marginBottom: 8 } } as const;

const s = StyleSheet.create((theme) => ({
  card: {
    gap: 6,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: ACCENT_BORDER,
    backgroundColor: theme.colors.surfaceAlt,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  header: { flexDirection: "row", alignItems: "center", gap: 6 },
  count: { fontFamily: "JetBrainsMono", fontSize: 12, color: theme.colors.fg },
  active: { flex: 1, fontSize: 12, color: theme.colors.fgMuted },
  track: {
    height: 3,
    borderRadius: 999,
    backgroundColor: theme.colors.border,
    overflow: "hidden",
  },
  fill: { height: 3, borderRadius: 999, backgroundColor: theme.colors.accent },
  fillDone: { backgroundColor: theme.colors.success },
  list: { maxHeight: 168 },
  listContent: { paddingTop: 4 },
}));
