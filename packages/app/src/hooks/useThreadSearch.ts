/**
 * In-thread search: the header toggle's query, its hits, and the highlight that
 * marks the one you're looking at.
 *
 * Two entry points share the highlight, which is why they live together:
 *
 *   - a search-hit DEEP LINK (`at`/`q` route params) jumps once on mount, after
 *     the full history has rendered — the recent-4 page won't contain an old
 *     match;
 *   - the header's own search box, debounced against this thread's history
 *     index, with prev/next hopping between hits.
 *
 * This hook CREATES state without subscribing to it (`useObservable`), so the
 * screen that calls it does not re-render when the query changes. The search bar
 * subscribes to what it displays and re-renders itself; see `ThreadSearchBar` in
 * screens/Session.tsx. Before that split, every keystroke re-rendered all ~1,800
 * lines of the session screen.
 */
import { useCallback } from "react";
import type { Observable } from "@legendapp/state";
import { useObservable, useObserveEffect } from "@legendapp/state/react";
import type { Session, TimelineEvent } from "@pounce/shared";
import { searchMessages, type MessageSearchHit } from "../services/bridge";

/** Below this, a query matches almost everything and is not worth a round trip. */
const MIN_THREAD_QUERY = 3;

export type ThreadSearch = {
  threadQuery$: Observable<string>;
  threadHits$: Observable<MessageSearchHit[]>;
  threadHitIdx$: Observable<number>;
  threadSearching$: Observable<boolean>;
  /** The event to mark, and the term to mark inside it. Changes once per jump,
   *  not per keystroke, so the screen subscribing to it is cheap. */
  searchHighlight$: Observable<{ id: string; term: string } | undefined>;
  /** Hop to `idx` (wrapping), highlight it, and scroll it into view. */
  goToHit: (hits: MessageSearchHit[], idx: number, term: string) => void;
  closeThreadSearch: () => void;
};

export function useThreadSearch({
  id,
  session,
  events,
  at,
  q,
  fullReady,
  findNearestIndex,
  jumpTo,
  threadSearchOpen,
  setThreadSearchOpen,
}: {
  id: string | undefined;
  session: Session | undefined;
  events: TimelineEvent[];
  /** Deep-link target timestamp. */
  at: string | undefined;
  /** Deep-link search term. */
  q: string | undefined;
  /** Has the FULL history landed? The jump is wrong before it has. */
  fullReady: boolean;
  findNearestIndex: (iso: string | null | undefined, term?: string) => number;
  jumpTo: (index: number) => void;
  threadSearchOpen: boolean;
  setThreadSearchOpen: (open: boolean) => void;
}): ThreadSearch {
  const threadQuery$ = useObservable("");
  const threadHits$ = useObservable<MessageSearchHit[]>([]);
  const threadHitIdx$ = useObservable(0);
  const threadSearching$ = useObservable(false);
  const searchHighlight$ = useObservable<{ id: string; term: string } | undefined>(undefined);
  const didJumpToAt$ = useObservable(false);
  const threadGen$ = useObservable(0);

  // --- deep link ---
  // `at`/`events`/`fullReady` are plain values, so this still needs deps; the
  // observables it writes are read with .get()/.set() and tracked by nothing.
  useObserveEffect(() => {
    if (!at || didJumpToAt$.peek() || !fullReady || events.length === 0) return;
    didJumpToAt$.set(true);
    const best = findNearestIndex(String(at), q ? String(q) : undefined);
    if (best >= 0) {
      if (q) searchHighlight$.set({ id: events[best].id, term: String(q) });
      // Repeatedly: the timeline's own open-at-bottom anchoring can land AFTER
      // the first jump and silently win, and on long threads scrollToIndex over
      // unmeasured history is approximate — later jumps correct the estimate as
      // items measure. scrollToIndex is idempotent.
      setTimeout(() => jumpTo(best), 350);
      setTimeout(() => jumpTo(best), 1300);
      setTimeout(() => jumpTo(best), 2800);
    }
  }, [at, q, fullReady, events, findNearestIndex, jumpTo]);

  const goToHit = useCallback(
    (hits: MessageSearchHit[], idx: number, term: string) => {
      if (!hits.length) return;
      const clamped = ((idx % hits.length) + hits.length) % hits.length;
      threadHitIdx$.set(clamped);
      const ei = findNearestIndex(hits[clamped].timestamp, term);
      if (ei >= 0) {
        searchHighlight$.set({ id: events[ei].id, term });
        jumpTo(ei);
      }
    },
    [events, findNearestIndex, jumpTo, threadHitIdx$, searchHighlight$],
  );

  // Re-runs when `threadQuery$` changes — it is READ here, so this effect
  // subscribes to it directly and no render is needed to drive the search.
  useObserveEffect(
    (e) => {
      const t = threadQuery$.get().trim();
      const gen = threadGen$.peek() + 1;
      threadGen$.set(gen);
      if (!threadSearchOpen || t.length < MIN_THREAD_QUERY || !session?.hostId || !id) {
        threadHits$.set([]);
        threadSearching$.set(false);
        return;
      }
      threadSearching$.set(true);
      const timer = setTimeout(async () => {
        const hits = await searchMessages(t, {
          thread: id,
          agent: session.agent,
          hostId: session.hostId,
          limit: 50,
        }).catch(() => []);
        if (threadGen$.peek() !== gen) return;
        threadHits$.set(hits);
        threadSearching$.set(false);
        goToHit(hits, 0, t);
      }, 350);
      e.onCleanup = () => clearTimeout(timer);
    },
    // `goToHit` changes with every event refresh; re-running the search then
    // would spam the bridge for nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [threadSearchOpen, session?.hostId, session?.agent, id],
  );

  const closeThreadSearch = useCallback(() => {
    setThreadSearchOpen(false);
    threadQuery$.set("");
    threadHits$.set([]);
    searchHighlight$.set(undefined);
  }, [setThreadSearchOpen, threadQuery$, threadHits$, searchHighlight$]);

  return {
    threadQuery$,
    threadHits$,
    threadHitIdx$,
    threadSearching$,
    searchHighlight$,
    goToHit,
    closeThreadSearch,
  };
}
