import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { LegendList } from "@legendapp/list/react-native";
import { useRouter } from "expo-router";
import type { Session } from "@pounce/shared";
import { useSessionsByLastActive } from "../state/db/hooks";
import { SessionCard } from "../components/SessionCard";
import { IS_DESKTOP } from "../ui";

/**
 * "All sessions" — every session flattened into one feed ordered by last
 * activity (newest first), across folders and devices. Reached from the Live
 * strip's header; the counterpart to Home's folder-grouped view.
 */
/** Hoisted for the same reason Home and Search hoist theirs: an inline arrow is
 *  a new reference on every render, which hands the list a fresh `renderItem`
 *  and re-renders every realised cell. LegendList absorbs this better than
 *  FlatList does — profiling this screen showed no measurable problem — but the
 *  two lists either side of it already guard against it, and there is no reason
 *  for this one to be the exception. */
const keyExtractor = (s: Session) => s.id;
const renderItem = ({ item }: { item: Session }) => (
  <View style={s.row}>
    <SessionCard session={item} />
  </View>
);

export default function SessionsScreen() {
  const router = useRouter();
  const sessions = useSessionsByLastActive();

  return (
    <View style={[s.root, s.rootPad]}>
      {/* Mobile shows the native modal navigation bar; this row is desktop chrome. */}
      {IS_DESKTOP ? (
        <View style={s.headerRow}>
          <View>
            <Text style={s.headerTitle}>All sessions</Text>
            <Text style={s.headerSub}>By last active</Text>
          </View>
          <Pressable onPress={() => router.back()} style={({ pressed }) => pressed && s.pressed60}>
            <Text style={s.doneLabel}>Done</Text>
          </Pressable>
        </View>
      ) : null}

      {sessions.length === 0 ? (
        <View style={s.empty}>
          <Text style={s.emptyTitle}>No sessions yet</Text>
          <Text style={s.emptyBody}>
            Start a task and your sessions will show up here, most recently active first.
          </Text>
        </View>
      ) : (
        <LegendList
          data={sessions}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          estimatedItemSize={104}
          keyboardDismissMode="on-drag"
          contentContainerStyle={s.listPad}
        />
      )}
    </View>
  );
}

const s = StyleSheet.create((theme, rt) => ({
  /** Safe-area padding in the sheet — applied natively, no re-render. */
  rootPad: { paddingTop: IS_DESKTOP ? rt.insets.top + 8 : 8 },
  listPad: { paddingTop: 4, paddingBottom: rt.insets.bottom + 24 },
  root: { flex: 1, backgroundColor: theme.colors.bg },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  headerTitle: { fontSize: 22, fontWeight: "700", color: theme.colors.fg },
  headerSub: { fontSize: 12, color: theme.colors.fgFaint },
  doneLabel: { fontSize: 15, color: theme.colors.fgMuted },
  pressed60: { opacity: 0.6 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 32 },
  emptyTitle: {
    marginTop: 12,
    textAlign: "center",
    fontSize: 15,
    fontWeight: "600",
    color: theme.colors.fg,
  },
  emptyBody: { marginTop: 4, textAlign: "center", fontSize: 13, color: theme.colors.fgMuted },
  row: { paddingHorizontal: 16, paddingBottom: 10 },
}));
