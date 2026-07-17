import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSelector } from "@legendapp/state/react";
import { Ionicons } from "@expo/vector-icons";
import type { Session } from "@pounce/shared";
import { searchMessages, type MessageSearchHit } from "../services/bridge";
import { applyFilters, filters$, rankSession } from "../state/stores";
import {
  useFavThreadSet,
  useIgnoredSet,
  useProjectNames,
  useThreads,
} from "../state/db/hooks";
import { SessionCard } from "../components/SessionCard";
import { FilterButton, FilterSheet } from "../components/FilterSheet";
import { cn, COLOR, inputH } from "../ui";

/** Search only kicks in at this many characters: short fragments match almost
 *  everything (useless results) and every keystroke below it would churn the
 *  list for nothing. Below the minimum the screen just shows all threads. */
const MIN_QUERY_LENGTH = 5;

/** Full-screen thread search — matches title, branch, host, agent, repo. */
export default function SearchScreen() {
  const insets = useSafeAreaInsets();
  // Desktop's sidebar seeds the modal via /search?q=… — start searching
  // immediately instead of making the user retype.
  const { q: seedQuery } = useLocalSearchParams<{ q?: string }>();
  const [query, setQuery] = useState(seedQuery ? String(seedQuery) : "");
  // The list filters on a DEBOUNCED query: re-filtering per keystroke changes
  // the LegendList data while the keyboard/layout is still settling, which
  // trips a maintainVisibleContentPosition recalculation loop inside
  // legend-list (max-update-depth crash, repro'd on 3.1.2–3.3.2). One update
  // after typing pauses is also just better UX on large thread lists.
  const [debouncedQuery, setDebouncedQuery] = useState(seedQuery ? String(seedQuery) : "");
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 250);
    return () => clearTimeout(timer);
  }, [query]);
  const [showFilters, setShowFilters] = useState(false);

  const raw = useThreads();
  const repoNames = useProjectNames();
  const ignored = useIgnoredSet();
  const filters = useSelector(() => filters$.get());
  const favSet = useFavThreadSet();

  const results = useMemo<Session[]>(() => {
    const t = debouncedQuery.trim().toLowerCase();
    let list = applyFilters(raw, { filters, ignored, repoName: (id) => repoNames[id] ?? "" });
    if (filters.favOnly) list = list.filter((s) => favSet.has(s.id));
    if (t.length >= MIN_QUERY_LENGTH) {
      list = list.filter((s) => {
        const repo = repoNames[s.repoId] ?? "";
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
  }, [raw, repoNames, ignored, debouncedQuery, filters, favSet]);

  // Keyed to the debounced query so the header/footer/empty views swap in the
  // same commit as the data they describe.
  const showAll = debouncedQuery.trim().length < MIN_QUERY_LENGTH;

  // Full-text hits from each device's history index (message bodies — the list
  // above only matches thread metadata). Rides the same debounced query as the
  // list; stale responses are dropped by generation counter so fast typing
  // can't reorder results. The effect depends on the query ONLY: store hooks
  // (useThreads/useIgnoredSet) return fresh objects per render, so having them
  // as effect deps while the effect sets state loops forever
  // (max-update-depth). Filtering happens in the useMemo below instead.
  const [rawHits, setRawHits] = useState<MessageSearchHit[]>([]);
  const [msgSearching, setMsgSearching] = useState(false);
  const msgGen = useRef(0);
  useEffect(() => {
    const t = debouncedQuery.trim();
    const gen = ++msgGen.current;
    if (t.length < MIN_QUERY_LENGTH) {
      setRawHits((prev) => (prev.length ? [] : prev));
      setMsgSearching(false);
      return;
    }
    setMsgSearching(true);
    void (async () => {
      const hits = await searchMessages(t).catch(() => []);
      if (msgGen.current !== gen) return;
      setRawHits(hits);
      setMsgSearching(false);
    })();
  }, [debouncedQuery]);
  const sessionById = useMemo(() => new Map(raw.map((s) => [s.id, s])), [raw]);
  // Message hits obey the SAME filter sheet as the thread list (project,
  // device, agent, favourites) — so selecting a folder scopes the full-text
  // search to that project. The allowed set is the filtered thread universe.
  const allowedIds = useMemo(() => {
    let list = applyFilters(raw, { filters, ignored, repoName: (id) => repoNames[id] ?? "" });
    if (filters.favOnly) list = list.filter((s) => favSet.has(s.id));
    return new Set(list.map((s) => s.id));
  }, [raw, repoNames, ignored, filters, favSet]);
  // Only hits that join to a synced, filter-visible session are shown (the
  // Session screen renders from the store). One row per thread: a thread can
  // surface multiple hits (and duplicate list keys), the first — best-ranked —
  // one wins.
  const msgHits = useMemo(() => {
    const seen = new Set<string>();
    return rawHits.filter((h) => {
      const key = `${h.hostId}:${h.threadId}`;
      if (seen.has(key)) return false;
      if (!allowedIds.has(h.threadId)) return false;
      seen.add(key);
      return true;
    });
  }, [rawHits, allowedIds]);

  return (
    <View className="flex-1 bg-bg" style={{ paddingTop: insets.top }}>
      <View className="flex-row items-center justify-between px-4 pb-2 pt-1">
        <Text className="text-[26px] font-bold text-fg">Search</Text>
        <FilterButton active={showFilters} onPress={() => setShowFilters(true)} />
      </View>

      {/* Search field */}
      <View className="mx-4 mb-2 h-11 flex-row items-center gap-2 rounded-2xl bg-surface-alt px-3">
        <Ionicons name="search" size={16} color={COLOR.fgFaint} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Find a thread…"
          placeholderTextColor={COLOR.fgFaint}
          autoCapitalize="none"
          autoCorrect={false}
          className={cn("flex-1 text-[15px] text-fg", inputH("h-11"))}
        />
        {query ? (
          <Pressable onPress={() => setQuery("")} className="active:opacity-60 p-1">
            <Ionicons name="close-circle" size={16} color={COLOR.fgFaint} />
          </Pressable>
        ) : null}
      </View>


      {/* Plain FlatList, NOT LegendList: on Fabric, legend-list's synchronous
          layout-effect measure loop turns fatal (max-update-depth, kills the
          whole tree) whenever the software keyboard opens over this screen —
          repro'd on legend-list 3.1.2/3.2.0/3.3.2 with recycling and MVCP both
          on and off, even with zero data changes. A search results list is
          small enough that FlatList virtualization is plenty. */}
      <FlatList
        style={{ flex: 1 }}
        data={results}
        keyExtractor={(s) => s.id}
        renderItem={({ item }) => (
          <View className="px-4 pb-2.5">
            <SessionCard session={item} />
          </View>
        )}
        keyboardDismissMode="on-drag"
        // First tap must PRESS the result, not just dismiss the keyboard —
        // without this, tapping a hit right after typing silently no-ops.
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          <Text className="px-4 pb-1.5 pt-1 text-[12px] uppercase tracking-wide text-fg-faint">
            {showAll ? "All threads" : `${results.length} match${results.length === 1 ? "" : "es"}`}
          </Text>
        }
        ListFooterComponent={
          !showAll && (msgSearching || msgHits.length > 0) ? (
            <View className="pt-2">
              <View className="flex-row items-center gap-2 px-4 pb-1.5">
                <Text className="text-[12px] uppercase tracking-wide text-fg-faint">In messages</Text>
                {msgSearching ? <ActivityIndicator size="small" color={COLOR.fgFaint} /> : null}
              </View>
              {msgHits.map((h) => (
                <MessageHitRow
                  key={`${h.hostId}:${h.threadId}`}
                  hit={h}
                  query={debouncedQuery.trim()}
                  session={sessionById.get(h.threadId)}
                />
              ))}
            </View>
          ) : null
        }
        ListEmptyComponent={
          // With message hits (or a search in flight) below, a tall "No
          // matches" hero would push the real results off-screen — the section
          // headers already say "0 matches", so show nothing extra.
          !showAll && (msgSearching || msgHits.length > 0) ? null : (
            <View className="items-center px-8 py-20">
              <Text className="text-[40px]">{showAll ? "🐾" : "🔍"}</Text>
              <Text className="mt-3 text-center text-[15px] font-semibold text-fg">
                {showAll ? "No threads yet" : "No matches"}
              </Text>
              <Text className="mt-1 text-center text-[13px] text-fg-muted">
                {showAll ? "Start a task to see it here." : "Try another word."}
              </Text>
            </View>
          )
        }
        contentContainerStyle={{ paddingTop: 4, paddingBottom: insets.bottom + 120 }}
      />

      <FilterSheet visible={showFilters} onClose={() => setShowFilters(false)} />
    </View>
  );
}

/** One full-text hit: thread title + matching snippet. Tapping opens the
 *  thread; the hit already joined to a synced session, so `/session/:id`
 *  renders from the store like any SessionCard tap. */
function MessageHitRow({
  hit,
  query,
  session,
}: {
  hit: MessageSearchHit;
  query: string;
  session?: Session;
}) {
  const router = useRouter();
  return (
    <Pressable
      // `at` scrolls the thread to the matched message; `q` paints the yellow
      // matched-term highlight on it (Session's deep link).
      onPress={() =>
        router.push(
          hit.timestamp
            ? `/session/${hit.threadId}?at=${encodeURIComponent(hit.timestamp)}&q=${encodeURIComponent(query)}`
            : `/session/${hit.threadId}`,
        )
      }
      className="mx-4 mb-2.5 rounded-2xl bg-surface-alt px-3.5 py-3 active:opacity-70"
    >
      <View className="flex-row items-center gap-2">
        <Text numberOfLines={1} className="flex-1 text-[14px] font-semibold text-fg">
          {session?.title || hit.title || hit.threadId}
        </Text>
        {hit.matches > 1 ? (
          <Text className="text-[11px] text-fg-faint">{hit.matches} matches</Text>
        ) : null}
      </View>
      <Text numberOfLines={2} className="mt-1 text-[13px] text-fg-muted">
        {hit.snippet}
      </Text>
      <Text numberOfLines={1} className="mt-1 text-[11px] text-fg-faint">
        {[session?.agent ?? hit.agent, session?.host, session?.branch].filter(Boolean).join(" · ")}
      </Text>
    </Pressable>
  );
}
