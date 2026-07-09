/**
 * Reactive reads for components. Each hook is a thin `useLiveQuery` over a
 * collection (see ./collections) and re-renders when that collection changes —
 * the react-db equivalent of the old `useSelector(() => …)` reads. Derived
 * shapes (Set/Map/Record) are memoized off the live-query data.
 */
import { useMemo } from "react";
import { eq, useLiveQuery } from "@tanstack/react-db";
import type { AgentCapabilities, Device, Host, Repository, Session, TimelineEvent } from "@litter/shared";
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
  recents,
  syncLog,
  threadModels,
  threads,
  type AgentModelsRow,
  type DeviceOverrideRow,
  type MessageRow,
  type RecentRow,
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
  const rows = (useLiveQuery((q) => q.from({ o: deviceOverrides })).data as DeviceOverrideRow[] | undefined) ?? [];
  return useMemo(() => Object.fromEntries(rows.map((o) => [o.id, o])), [rows]);
}

export function useRecents(): RecentRow[] {
  return (useLiveQuery((q) => q.from({ r: recents })).data as RecentRow[] | undefined) ?? [];
}

/** Threads the user opened most recently (newest first) that still exist —
 *  drives "Jump back in". Ordering comes from visits, not agent activity. */
export function useRecentSessions(limit: number): Session[] {
  const opens = useRecents();
  const all = useThreads();
  return useMemo(() => {
    const byId = new Map(all.map((s) => [s.id, s]));
    return opens
      .filter((o) => byId.has(o.id))
      .sort((a, b) => Date.parse(b.openedAt) - Date.parse(a.openedAt))
      .slice(0, limit)
      .map((o) => byId.get(o.id)!);
  }, [opens, all, limit]);
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
  const rows = (useLiveQuery((q) => q.from({ f: favorites })).data as { kind: string; ref: string }[] | undefined) ?? [];
  return useMemo(() => new Set(rows.filter((f) => f.kind === "thread").map((f) => f.ref)), [rows]);
}
export function useFavRepoSet(): Set<string> {
  const rows = (useLiveQuery((q) => q.from({ f: favorites })).data as { kind: string; ref: string }[] | undefined) ?? [];
  return useMemo(() => new Set(rows.filter((f) => f.kind === "repo").map((f) => f.ref)), [rows]);
}

export function useIgnoredSet(): Set<string> {
  const rows = (useLiveQuery((q) => q.from({ i: ignoredRepos })).data as { id: string }[] | undefined) ?? [];
  return useMemo(() => new Set(rows.map((r) => r.id)), [rows]);
}

export function useThread(id: string | undefined): Session | undefined {
  const rows =
    (useLiveQuery((q) => (id ? q.from({ t: threads }).where(({ t }) => eq(t.id, id)) : q.from({ t: threads })), [id])
      .data as Session[] | undefined) ?? [];
  return id ? rows.find((s) => s.id === id) : undefined;
}

export function useThreadModel(id: string | undefined): string | undefined {
  const rows =
    (useLiveQuery((q) => q.from({ m: threadModels }), []).data as { id: string; model: string }[] | undefined) ?? [];
  return id ? rows.find((r) => r.id === id)?.model : undefined;
}

/** Reactive capabilities for one agent (null until reported). */
export function useAgentCaps(agent: string | undefined): AgentCapabilities | null {
  const rows = (useLiveQuery((q) => q.from({ a: agentCaps })).data as (AgentCapabilities & { id: string })[] | undefined) ?? [];
  return useMemo(() => (agent ? rows.find((a) => a.id === agent) ?? null : null), [rows, agent]);
}

/** Reactive cached model catalog for a host+agent (null until warmed). */
export function useAgentModels(hostId: string, agent: string): ModelInfo[] | null {
  const key = `${hostId}:${agent}`;
  const rows = (useLiveQuery((q) => q.from({ a: agentModels }), []).data as AgentModelsRow[] | undefined) ?? [];
  return useMemo(() => rows.find((r) => r.id === key)?.models ?? null, [rows, key]);
}

/** messageId → explicit marked override, for one session. */
export function useThreadMarkers(sessionId: string | undefined): Map<string, boolean> {
  const rows = (useLiveQuery((q) => q.from({ m: markers }), []).data as { id: string; marked: boolean }[] | undefined) ?? [];
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
    (useLiveQuery((q) => (threadId ? q.from({ m: messages }).where(({ m }) => eq(m.threadId, threadId)) : q.from({ m: messages })), [threadId])
      .data as MessageRow[] | undefined) ?? [];
  return useMemo(
    () => (threadId ? rows.filter((m) => m.threadId === threadId).map((m) => m.event) : []),
    [rows, threadId],
  );
}
