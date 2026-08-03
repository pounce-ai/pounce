/**
 * Reactive reads for components. Each hook is a thin `useLiveQuery` over a
 * collection (see ./collections) and re-renders when that collection changes —
 * the react-db equivalent of the old `useSelector(() => …)` reads. Derived
 * shapes (Set/Map/Record) are memoized off the live-query data.
 */
import { useMemo } from "react";
import { eq, useLiveQuery } from "@tanstack/react-db";
import type {
  AgentCapabilities,
  Device,
  Host,
  Repository,
  Session,
  TimelineEvent,
} from "@pounce/shared";
import type { ModelInfo } from "../../services/bridge";
import {
  agentCaps,
  agentModels,
  deviceOverrides,
  devices,
  favorites,
  hosts,
  ignoredRepos,
  markers,
  messages,
  projects,
  syncLog,
  threadModels,
  threads,
  type AgentModelsRow,
  type DeviceOverrideRow,
  type MessageRow,
  type SyncLogRow,
} from "./collections";

export function useThreads(): Session[] {
  return (useLiveQuery((q) => q.from({ t: threads })).data as Session[] | undefined) ?? [];
}

export function useProjects(): Repository[] {
  return (useLiveQuery((q) => q.from({ r: projects })).data as Repository[] | undefined) ?? [];
}

export function useDevices(): Device[] {
  return (useLiveQuery((q) => q.from({ d: devices })).data as Device[] | undefined) ?? [];
}

export function useDevicesById(): Record<string, Device> {
  const list = useDevices();
  return useMemo(() => Object.fromEntries(list.map((d) => [d.id, d])), [list]);
}

export function useHosts(): Host[] {
  return (useLiveQuery((q) => q.from({ h: hosts })).data as Host[] | undefined) ?? [];
}

/** deviceId → { name?, emoji? } presentation overrides. */
export function useDeviceOverrides(): Record<string, DeviceOverrideRow> {
  const rows =
    (useLiveQuery((q) => q.from({ o: deviceOverrides })).data as DeviceOverrideRow[] | undefined) ??
    [];
  return useMemo(() => Object.fromEntries(rows.map((o) => [o.id, o])), [rows]);
}

/** Threads eligible to surface in the Live strip / activity list: not in an
 *  ignored or dotfolder repo (dotfolders stay hidden everywhere). */
function useVisibleThreads(): Session[] {
  const all = useThreads();
  const ignored = useIgnoredSet();
  const names = useProjectNames();
  return useMemo(
    () => all.filter((s) => !ignored.has(s.repoId) && !(names[s.repoId] ?? "").startsWith(".")),
    [all, ignored, names],
  );
}

/** Sessions whose agent is working right now (running/streaming), most-recent
 *  activity first — the primary content of the Live strip. */
export function useLiveSessions(): Session[] {
  const visible = useVisibleThreads();
  return useMemo(
    () =>
      visible
        .filter((s) => s.activity === "running" || s.activity === "streaming")
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
    [visible],
  );
}

/** All visible sessions ordered by last activity (newest first). `limit` caps
 *  the count; omit for the full ordered list. */
export function useSessionsByLastActive(limit?: number): Session[] {
  const visible = useVisibleThreads();
  return useMemo(() => {
    const sorted = [...visible].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    return limit == null ? sorted : sorted.slice(0, limit);
  }, [visible, limit]);
}

/** repoId → display name, for cheap lookups in lists. */
export function useProjectNames(): Record<string, string> {
  const list = useProjects();
  return useMemo(() => Object.fromEntries(list.map((r) => [r.id, r.name])), [list]);
}

export function useSyncLog(): SyncLogRow[] {
  return (useLiveQuery((q) => q.from({ s: syncLog })).data as SyncLogRow[] | undefined) ?? [];
}

export function useFavThreadSet(): Set<string> {
  const rows =
    (useLiveQuery((q) => q.from({ f: favorites })).data as
      | { kind: string; ref: string }[]
      | undefined) ?? [];
  return useMemo(() => new Set(rows.filter((f) => f.kind === "thread").map((f) => f.ref)), [rows]);
}
export function useFavRepoSet(): Set<string> {
  const rows =
    (useLiveQuery((q) => q.from({ f: favorites })).data as
      | { kind: string; ref: string }[]
      | undefined) ?? [];
  return useMemo(() => new Set(rows.filter((f) => f.kind === "repo").map((f) => f.ref)), [rows]);
}

export function useIgnoredSet(): Set<string> {
  const rows =
    (useLiveQuery((q) => q.from({ i: ignoredRepos })).data as { id: string }[] | undefined) ?? [];
  return useMemo(() => new Set(rows.map((r) => r.id)), [rows]);
}

export function useThread(id: string | undefined): Session | undefined {
  const rows =
    (useLiveQuery(
      (q) => (id ? q.from({ t: threads }).where(({ t }) => eq(t.id, id)) : q.from({ t: threads })),
      [id],
    ).data as Session[] | undefined) ?? [];
  return id ? rows.find((s) => s.id === id) : undefined;
}

export function useThreadModel(id: string | undefined): string | undefined {
  const rows =
    (useLiveQuery((q) => q.from({ m: threadModels }), []).data as
      | { id: string; model: string }[]
      | undefined) ?? [];
  return id ? rows.find((r) => r.id === id)?.model : undefined;
}

/** Reactive capabilities for one agent (null until reported). */
export function useAgentCaps(agent: string | undefined): AgentCapabilities | null {
  const rows =
    (useLiveQuery((q) => q.from({ a: agentCaps })).data as
      | (AgentCapabilities & { id: string })[]
      | undefined) ?? [];
  return useMemo(() => (agent ? (rows.find((a) => a.id === agent) ?? null) : null), [rows, agent]);
}

/** Reactive cached model catalog for a host+agent (null until warmed). */
export function useAgentModels(hostId: string, agent: string): ModelInfo[] | null {
  const key = `${hostId}:${agent}`;
  const rows =
    (useLiveQuery((q) => q.from({ a: agentModels }), []).data as AgentModelsRow[] | undefined) ??
    [];
  return useMemo(() => rows.find((r) => r.id === key)?.models ?? null, [rows, key]);
}

/** messageId → explicit marked override, for one session. */
export function useThreadMarkers(sessionId: string | undefined): Map<string, boolean> {
  const rows =
    (useLiveQuery((q) => q.from({ m: markers }), []).data as
      | { id: string; marked: boolean }[]
      | undefined) ?? [];
  return useMemo(() => {
    const map = new Map<string, boolean>();
    if (!sessionId) return map;
    for (const m of rows) {
      const [sid, mid] = m.id.split("|");
      if (sid === sessionId) map.set(mid, m.marked);
    }
    return map;
  }, [rows, sessionId]);
}

/** Persisted chat events for a thread (raw, unsorted — caller orders). */
export function useMessages(threadId: string | undefined): TimelineEvent[] {
  const rows =
    (useLiveQuery(
      (q) =>
        threadId
          ? q.from({ m: messages }).where(({ m }) => eq(m.threadId, threadId))
          : q.from({ m: messages }),
      [threadId],
    ).data as MessageRow[] | undefined) ?? [];
  // `rows` is a fresh array every render, so keying the memo on it re-filtered
  // and re-mapped the whole transcript — hundreds of events — on every single
  // render of the session screen, and handed back a new array that invalidated
  // everything downstream. Key on the CONTENT instead: chat history is
  // append-only, so a count and the last id identify it.
  const sig = threadId ? `${rows.length}:${rows[rows.length - 1]?.id ?? ""}` : "";
  return useMemo(
    () => (threadId ? rows.filter((m) => m.threadId === threadId).map((m) => m.event) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `sig` stands in for `rows`
    [sig, threadId],
  );
}
