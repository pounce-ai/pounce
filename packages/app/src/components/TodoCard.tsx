import { type ColorValue, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { PounceIcon } from "../ui/native/Icon";
import type { IoniconName } from "../ui/native/icon-map";
import { type TaskItem, taskProgress } from "./taskEvents";

const ICON: Record<TaskItem["status"], IoniconName> = {
  completed: "checkmark-circle",
  in_progress: "radio-button-on",
  pending: "ellipse-outline",
};

/** The task checklist itself — shared by the inline card and the pinned widget. */
export function TodoRows({ items, compact }: { items: readonly TaskItem[]; compact?: boolean }) {
  const { theme } = useUnistyles();
  const color: Record<TaskItem["status"], ColorValue> = {
    completed: theme.colors.success,
    in_progress: theme.colors.accent,
    pending: theme.colors.fgFaint,
  };
  return (
    <View style={compact ? s.rowsCompact : s.rows}>
      {items.map((it, i) => (
        <View key={`${i}:${it.text}`} style={s.row}>
          <PounceIcon name={ICON[it.status]} size={13} color={color[it.status]} style={s.rowIcon} />
          <Text style={[s.rowText, s[it.status]]}>
            {it.status === "in_progress" ? it.activeForm || it.text : it.text}
          </Text>
        </View>
      ))}
    </View>
  );
}

/**
 * The agent's task list as a checklist instead of a generic tool card — this IS
 * the plan, the most legible row in the turn.
 *
 * Agents touch the list constantly (a whole-list rewrite, or a create/update per
 * tick), so Timeline renders this card only at the NEWEST task event, with the
 * folded state; the superseded events stay one-line trace rows.
 */
export function TodoCard({ items, latest }: { items: readonly TaskItem[]; latest?: boolean }) {
  const { theme } = useUnistyles();
  const p = taskProgress(items);
  const allDone = p.done === p.total;
  return (
    <View style={[s.card, latest && s.cardLatest]}>
      <View style={s.header}>
        <PounceIcon
          name={allDone ? "checkmark-circle" : "checkbox"}
          size={13}
          color={allDone ? theme.colors.success : theme.colors.accent}
        />
        <Text style={s.label}>Tasks</Text>
        <Text style={s.count}>
          {p.done}/{p.total}
        </Text>
      </View>
      <TodoRows items={items} />
    </View>
  );
}

const s = StyleSheet.create((theme) => ({
  card: {
    gap: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  cardLatest: { borderColor: theme.colors.accentLine, backgroundColor: theme.colors.accentTint },
  header: { flexDirection: "row", alignItems: "center", gap: 6 },
  label: {
    fontSize: 12,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    color: theme.colors.accent,
  },
  count: { fontFamily: "JetBrainsMono", fontSize: 12, color: theme.colors.fgMuted },
  rows: { gap: 6 },
  rowsCompact: { gap: 4 },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  // Nudge the glyph onto the text's first-line baseline.
  rowIcon: { marginTop: 2 },
  rowText: { flex: 1, fontSize: 13, lineHeight: 18 },
  completed: { color: theme.colors.fgFaint, textDecorationLine: "line-through" },
  in_progress: { color: theme.colors.fg, fontWeight: "600" },
  pending: { color: theme.colors.fgMuted },
}));
