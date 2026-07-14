import { Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LegendList } from "@legendapp/list/react-native";
import { useRouter } from "expo-router";
import { useSessionsByLastActive } from "../state/db/hooks";
import { SessionCard } from "../components/SessionCard";

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
    <View className="flex-1 bg-bg" style={{ paddingTop: insets.top + 8 }}>
      <View className="flex-row items-center justify-between px-4 pb-3">
        <View>
          <Text className="text-[22px] font-bold text-fg">All sessions</Text>
          <Text className="text-[12px] text-fg-faint">By last active</Text>
        </View>
        <Pressable onPress={() => router.back()} className="active:opacity-60">
          <Text className="text-[15px] text-fg-muted">Done</Text>
        </Pressable>
      </View>

      {sessions.length === 0 ? (
        <View className="flex-1 items-center justify-center px-8">
          <Text className="text-[40px]">🐾</Text>
          <Text className="mt-3 text-center text-[15px] font-semibold text-fg">No sessions yet</Text>
          <Text className="mt-1 text-center text-[13px] text-fg-muted">
            Start a task and your sessions will show up here, most recently active first.
          </Text>
        </View>
      ) : (
        <LegendList
          data={sessions}
          keyExtractor={(s) => s.id}
          renderItem={({ item }) => (
            <View className="px-4 pb-2.5">
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
