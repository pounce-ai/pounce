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
 * Extracted from Session.tsx verbatim. This is a custom hook, so the state
 * still belongs to the calling component and the render behaviour is unchanged
 * — the point is that ~75 lines of one concern now read on their own instead of
 * interleaved with seven other clusters.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Session, TimelineEvent } from "@pounce/shared";
import { searchMessages, type MessageSearchHit } from "../services/bridge";

/** Below this, a query matches almost everything and is not worth a round trip. */
const MIN_THREAD_QUERY = 3;

export type ThreadSearch = {
  /** The event to mark, and the term to mark inside it. */
  searchHighlight: { id: string; term: string } | undefined;
  threadQuery: string;
  setThreadQuery: (q: string) => void;
  threadHits: MessageSearchHit[];
  threadHitIdx: number;
  threadSearching: boolean;
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
  const [searchHighlight, setSearchHighlight] = useState<
    { id: string; term: string } | undefined
  >();

  // --- deep link ---
  const didJumpToAt = useRef(false);
  useEffect(() => {
    if (!at || didJumpToAt.current || !fullReady || events.length === 0) return;
    didJumpToAt.current = true;
    const best = findNearestIndex(String(at), q ? String(q) : undefined);
    if (best >= 0) {
      if (q) setSearchHighlight({ id: events[best].id, term: String(q) });
      // Repeatedly: the timeline's own open-at-bottom anchoring can land AFTER
      // the first jump and silently win, and on long threads scrollToIndex over
      // unmeasured history is approximate — later jumps correct the estimate as
      // items measure. scrollToIndex is idempotent.
      setTimeout(() => jumpTo(best), 350);
      setTimeout(() => jumpTo(best), 1300);
      setTimeout(() => jumpTo(best), 2800);
    }
  }, [at, q, fullReady, events, findNearestIndex, jumpTo]);

  // --- header search box ---
  const [threadQuery, setThreadQuery] = useState("");
  const [threadHits, setThreadHits] = useState<MessageSearchHit[]>([]);
  const [threadHitIdx, setThreadHitIdx] = useState(0);
  const [threadSearching, setThreadSearching] = useState(false);
  const threadGen = useRef(0);

  const goToHit = useCallback(
    (hits: MessageSearchHit[], idx: number, term: string) => {
      if (!hits.length) return;
      const clamped = ((idx % hits.length) + hits.length) % hits.length;
      setThreadHitIdx(clamped);
      const ei = findNearestIndex(hits[clamped].timestamp, term);
      if (ei >= 0) {
        setSearchHighlight({ id: events[ei].id, term });
        jumpTo(ei);
      }
    },
    [events, findNearestIndex, jumpTo],
  );

  useEffect(() => {
    const t = threadQuery.trim();
    const gen = ++threadGen.current;
    if (!threadSearchOpen || t.length < MIN_THREAD_QUERY || !session?.hostId || !id) {
      setThreadHits([]);
      setThreadSearching(false);
      return;
    }
    setThreadSearching(true);
    const timer = setTimeout(async () => {
      const hits = await searchMessages(t, {
        thread: id,
        agent: session.agent,
        hostId: session.hostId,
        limit: 50,
      }).catch(() => []);
      if (threadGen.current !== gen) return;
      setThreadHits(hits);
      setThreadSearching(false);
      goToHit(hits, 0, t);
    }, 350);
    return () => clearTimeout(timer);
    // goToHit changes with every event refresh; re-running the search then
    // would spam the bridge for nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadSearchOpen, threadQuery, session?.hostId, session?.agent, id]);

  // `setThreadSearchOpen` comes from the chrome seam, not useState — it isn't a
  // guaranteed-stable identity, so it has to be a dependency.
  const closeThreadSearch = useCallback(() => {
    setThreadSearchOpen(false);
    setThreadQuery("");
    setThreadHits([]);
    setSearchHighlight(undefined);
  }, [setThreadSearchOpen]);

  return {
    searchHighlight,
    threadQuery,
    setThreadQuery,
    threadHits,
    threadHitIdx,
    threadSearching,
    goToHit,
    closeThreadSearch,
  };
}
