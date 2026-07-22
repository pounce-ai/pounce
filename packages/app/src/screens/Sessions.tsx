import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LegendList } from "@legendapp/list/react-native";
import { useRouter } from "expo-router";
import { useSessionsByLastActive } from "../state/db/hooks";
import { SessionCard } from "../components/SessionCard";
import { IS_DESKTOP } from "../ui";

/**
 * "All sessions" — every session flattened into one feed ordered by last
 * activity (newest first), across folders and devices. Reached from the Live
 * strip's header; the counterpart to Home's folder-grouped view.
 */
export default function SessionsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const sessions = useSessionsByLastActive();

  return (
    <View style={[s.root, IS_DESKTOP ? { paddingTop: insets.top + 8 } : { paddingTop: 8 }]}>
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
          <Text style={s.emptyEmoji}>🐾</Text>
          <Text style={s.emptyTitle}>No sessions yet</Text>
          <Text style={s.emptyBody}>
            Start a task and your sessions will show up here, most recently active first.
          </Text>
        </View>
      ) : (
        <LegendList
          data={sessions}
          keyExtractor={(s) => s.id}
          renderItem={({ item }) => (
            <View style={s.row}>
              <SessionCard session={item} />
            </View>
          )}
          estimatedItemSize={104}
          keyboardDismissMode="on-drag"
          contentContainerStyle={{ paddingTop: 4, paddingBottom: insets.bottom + 24 }}
        />
      )}
    </View>
  );
}

const s = StyleSheet.create((theme) => ({
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
  emptyEmoji: { fontSize: 40 },
  emptyTitle: { marginTop: 12, textAlign: "center", fontSize: 15, fontWeight: "600", color: theme.colors.fg },
  emptyBody: { marginTop: 4, textAlign: "center", fontSize: 13, color: theme.colors.fgMuted },
  row: { paddingHorizontal: 16, paddingBottom: 10 },
}));
