import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Platform, Pressable, Text, TextInput, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSelector } from "@legendapp/state/react";
import { PounceIcon } from "../ui/native/Icon";
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
import { IS_DESKTOP } from "../ui";
import { searchQuery$ } from "../state/search";

/** Search only kicks in at this many characters: short fragments match almost
 *  everything (useless results) and every keystroke below it would churn the
 *  list for nothing. Below the minimum the screen just shows all threads. */
const MIN_QUERY_LENGTH = 5;

/** Full-screen thread search — matches title, branch, host, agent, repo. */
export default function SearchScreen() {
  const insets = useSafeAreaInsets();
  const { theme } = useUnistyles();
  // Desktop's sidebar seeds the modal via /search?q=… — start searching
  // immediately instead of making the user retype.
  const { q: seedQuery } = useLocalSearchParams<{ q?: string }>();
  // Desktop types into the in-screen TextInput (local state); mobile types into
  // the native UISearchBar in the navigation bar, which writes searchQuery$.
  const [localQuery, setLocalQuery] = useState(seedQuery ? String(seedQuery) : "");
  const nativeQuery = useSelector(() => searchQuery$.get());
  useEffect(() => {
    if (!IS_DESKTOP && seedQuery) searchQuery$.set(String(seedQuery));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const query = IS_DESKTOP ? localQuery : nativeQuery;
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
    <View style={[s.root, IS_DESKTOP ? { paddingTop: insets.top } : undefined]}>
      {/* Mobile's filter button lives in the navigation bar (search/_layout
          headerRight) — a row here would hide under the transparent
          large-title header, which only insets the FlatList below. Desktop
          keeps its own chrome. */}
      {IS_DESKTOP ? (
        <View style={s.desktopHeader}>
          <Text style={s.title}>Search</Text>
          <FilterButton active={showFilters} onPress={() => setShowFilters(true)} />
        </View>
      ) : null}

      {IS_DESKTOP ? (
        <View style={s.searchBox}>
          <PounceIcon name="search" size={16} color={theme.colors.fgFaint} />
          <TextInput
            value={localQuery}
            onChangeText={setLocalQuery}
            placeholder="Find a thread…"
            placeholderTextColor={theme.colors.fgFaint}
            autoCapitalize="none"
            autoCorrect={false}
            style={[s.input, IS_DESKTOP && s.inputDesktop]}
          />
          {localQuery ? (
            <Pressable onPress={() => setLocalQuery("")} style={({ pressed }) => [s.clearBtn, pressed && s.pressed60]}>
              <PounceIcon name="close-circle" size={16} color={theme.colors.fgFaint} />
            </Pressable>
          ) : null}
        </View>
      ) : null}


      {/* Plain FlatList, NOT LegendList: on Fabric, legend-list's synchronous
          layout-effect measure loop turns fatal (max-update-depth, kills the
          whole tree) whenever the software keyboard opens over this screen —
          repro'd on legend-list 3.1.2/3.2.0/3.3.2 with recycling and MVCP both
          on and off, even with zero data changes. A search results list is
          small enough that FlatList virtualization is plenty. */}
      <FlatList
        style={{ flex: 1 }}
        contentInsetAdjustmentBehavior="automatic"
        data={results}
        keyExtractor={(s) => s.id}
        renderItem={({ item }) => (
          <View style={s.resultRow}>
            <SessionCard session={item} />
          </View>
        )}
        keyboardDismissMode="on-drag"
        // First tap must PRESS the result, not just dismiss the keyboard —
        // without this, tapping a hit right after typing silently no-ops.
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          <Text style={s.listHeader}>
            {showAll ? "All threads" : `${results.length} match${results.length === 1 ? "" : "es"}`}
          </Text>
        }
        ListFooterComponent={
          !showAll && (msgSearching || msgHits.length > 0) ? (
            <View style={s.footer}>
              <View style={s.footerHeaderRow}>
                <Text style={s.sectionLabel}>In messages</Text>
                {msgSearching ? <ActivityIndicator size="small" color={theme.colors.fgFaint} /> : null}
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
            <View style={s.empty}>
              <Text style={s.emptyEmoji}>{showAll ? "🐾" : "🔍"}</Text>
              <Text style={s.emptyTitle}>
                {showAll ? "No threads yet" : "No matches"}
              </Text>
              <Text style={s.emptyBody}>
                {showAll ? "Start a task to see it here." : "Try another word."}
              </Text>
            </View>
          )
        }
        // Android ignores contentInsetAdjustmentBehavior (iOS-only), so the
        // list needs real top padding below the in-flow toolbar + search bar.
        contentContainerStyle={{
          paddingTop: Platform.OS === "android" ? 16 : 4,
          paddingBottom: insets.bottom + 16,
        }}
      />

      {IS_DESKTOP ? <FilterSheet visible={showFilters} onClose={() => setShowFilters(false)} /> : null}
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
      style={({ pressed }) => [s.hitCard, pressed && s.pressed70]}
    >
      <View style={s.hitTitleRow}>
        <Text numberOfLines={1} style={s.hitTitle}>
          {session?.title || hit.title || hit.threadId}
        </Text>
        {hit.matches > 1 ? (
          <Text style={s.hitMeta}>{hit.matches} matches</Text>
        ) : null}
      </View>
      <Text numberOfLines={2} style={s.hitSnippet}>
        {hit.snippet}
      </Text>
      <Text numberOfLines={1} style={s.hitFooter}>
        {[session?.agent ?? hit.agent, session?.host, session?.branch].filter(Boolean).join(" · ")}
      </Text>
    </Pressable>
  );
}

const s = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.bg },
  desktopHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 8,
    paddingTop: 4,
  },
  title: { fontSize: 26, fontWeight: "700", color: theme.colors.fg },
  mobileFilterRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    paddingHorizontal: 16,
    paddingBottom: 4,
    paddingTop: 8,
  },
  searchBox: {
    marginHorizontal: 16,
    marginBottom: 8,
    height: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: 16,
    backgroundColor: theme.colors.surfaceAlt,
    paddingHorizontal: 12,
  },
  input: { flex: 1, fontSize: 15, color: theme.colors.fg, height: 44 },
  // Desktop centers intrinsic-height inputs (see inputH's comment in ui/index.tsx).
  inputDesktop: { height: "auto" as const, paddingVertical: 0 },
  clearBtn: { padding: 4 },
  resultRow: { paddingHorizontal: 16, paddingBottom: 10 },
  listHeader: {
    paddingHorizontal: 16,
    paddingBottom: 6,
    paddingTop: 4,
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    color: theme.colors.fgFaint,
  },
  footer: { paddingTop: 8 },
  footerHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 6,
  },
  sectionLabel: { fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5, color: theme.colors.fgFaint },
  empty: { alignItems: "center", paddingHorizontal: 32, paddingVertical: 80 },
  emptyEmoji: { fontSize: 40 },
  emptyTitle: { marginTop: 12, textAlign: "center", fontSize: 15, fontWeight: "600", color: theme.colors.fg },
  emptyBody: { marginTop: 4, textAlign: "center", fontSize: 13, color: theme.colors.fgMuted },
  hitCard: {
    marginHorizontal: 16,
    marginBottom: 10,
    borderRadius: 16,
    backgroundColor: theme.colors.surfaceAlt,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  hitTitleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  hitTitle: { flex: 1, fontSize: 14, fontWeight: "600", color: theme.colors.fg },
  hitMeta: { fontSize: 11, color: theme.colors.fgFaint },
  hitSnippet: { marginTop: 4, fontSize: 13, color: theme.colors.fgMuted },
  hitFooter: { marginTop: 4, fontSize: 11, color: theme.colors.fgFaint },
  pressed60: { opacity: 0.6 },
  pressed70: { opacity: 0.7 },
}));
