import { QueryClient } from "@tanstack/react-query";

/**
 * React Query handles host-fetched, cacheable reads (agents, repo trees, git
 * status, history). Live streams use the runtime adapter, not React Query.
 * Offline-friendly defaults: long staleness, retry with backoff, served from
 * cache while disconnected.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 1000 * 60 * 60 * 24,
      retry: 2,
      refetchOnWindowFocus: false,
      networkMode: "offlineFirst",
    },
    mutations: {
      networkMode: "offlineFirst",
    },
  },
});
