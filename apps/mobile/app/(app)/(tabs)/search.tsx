import { useMemo, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LegendList } from "@legendapp/list/react-native";
import { useSelector } from "@legendapp/state/react";
import { Ionicons } from "@expo/vector-icons";
import type { Session } from "@litter/shared";
import {
  applyFilters,
  favThreads$,
  filters$,
  rankSession,
  rawSessions,
  repositories$,
} from "@/state/stores";
import { SessionCard } from "@/components/SessionCard";
import { FilterButton, FilterSheet } from "@/components/FilterSheet";
import { COLOR } from "@/ui";

/** Full-screen thread search — matches title, branch, host, agent, repo. */
export default function SearchScreen() {
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState("");
  const [showFilters, setShowFilters] = useState(false);

  const raw = useSelector(() => rawSessions());
  const repos = useSelector(() => repositories$.get());
  const favOnly = useSelector(() => filters$.favOnly.get());
  const favMap = useSelector(() => favThreads$.get());

  const results = useMemo<Session[]>(() => {
    const t = query.trim().toLowerCase();
    let list = applyFilters(raw);
    if (favOnly) list = list.filter((s) => favMap[s.id]);
    if (t) {
      list = list.filter((s) => {
        const repo = repos[s.repoId]?.name ?? "";
        return (
          s.title.toLowerCase().includes(t) ||
          (s.branch ?? "").toLowerCase().includes(t) ||
          s.host.toLowerCase().includes(t) ||
          s.agent.includes(t) ||
          repo.toLowerCase().includes(t)
        );
      });
    }
    return [...list].sort((a, b) => rankSession(a) - rankSession(b) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }, [raw, repos, query, favOnly, favMap]);

  const showAll = query.trim().length === 0;

  return (
    <View className="flex-1 bg-bg" style={{ paddingTop: insets.top }}>
      <View className="flex-row items-center justify-between px-4 pb-2 pt-1">
        <Text className="text-[26px] font-bold text-fg">Search</Text>
        <FilterButton active={showFilters} onPress={() => setShowFilters(true)} />
      </View>

      {/* Search field */}
      <View className="mx-4 mb-2 flex-row items-center gap-2 rounded-2xl bg-surface-alt px-3">
        <Ionicons name="search" size={16} color={COLOR.fgFaint} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Find a thread…"
          placeholderTextColor={COLOR.fgFaint}
          autoCapitalize="none"
          autoCorrect={false}
          className="h-11 flex-1 text-[15px] text-fg"
        />
        {query ? (
          <Pressable onPress={() => setQuery("")} className="active:opacity-60 p-1">
            <Ionicons name="close-circle" size={16} color={COLOR.fgFaint} />
          </Pressable>
        ) : null}
      </View>


      <LegendList
        style={{ flex: 1 }}
        data={results}
        keyExtractor={(s) => s.id}
        renderItem={({ item }) => (
          <View className="px-4 pb-2.5">
            <SessionCard session={item} />
          </View>
        )}
        estimatedItemSize={104}
        recycleItems
        keyboardDismissMode="on-drag"
        ListHeaderComponent={
          <Text className="px-4 pb-1.5 pt-1 text-[12px] uppercase tracking-wide text-fg-faint">
            {showAll ? "All threads" : `${results.length} match${results.length === 1 ? "" : "es"}`}
          </Text>
        }
        ListEmptyComponent={
          <View className="items-center px-8 py-20">
            <Text className="text-[40px]">{showAll ? "🐾" : "🔍"}</Text>
            <Text className="mt-3 text-center text-[15px] font-semibold text-fg">
              {showAll ? "No threads yet" : "No matches"}
            </Text>
            <Text className="mt-1 text-center text-[13px] text-fg-muted">
              {showAll ? "Start a task to see it here." : "Try another word."}
            </Text>
          </View>
        }
        contentContainerStyle={{ paddingTop: 4, paddingBottom: insets.bottom + 120 }}
      />

      <FilterSheet visible={showFilters} onClose={() => setShowFilters(false)} />
    </View>
  );
}
