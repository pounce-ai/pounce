/**
 * The relational model, as @tanstack/react-db collections persisted to MMKV.
 * This replaces the pile of independent Legend State maps: entities are rows
 * with stable keys, so cross-entity operations (join, cascade-delete, query)
 * are first-class instead of hand-maintained.
 *
 *   devices ─< threads >─ projects
 *   threads ─< messages
 *   threads ─ recents / threadModels / markers / favorites(thread)
 *   projects ─ ignoredRepos / favorites(repo)
 *
 * Pure UI singletons (filters, connection, pendingTurns, user) stay in Legend
 * State — they aren't relational. See ./storage for the MMKV backing.
 */
import type {
  AgentCapabilities,
  Device,
  Host,
  Repository,
  Session,
  TimelineEvent,
} from "@pounce/shared";
import type { ModelInfo } from "../../services/bridge";
import { mmkvCollection } from "./storage";

// --- row shapes for the non-shared (local-only) collections ---

/** Last time the user opened a thread — drives "Jump back in". */
export type RecentRow = { id: string; openedAt: string };
/** One sync event (busiest repos first) — the Sync-history feed. */
export type SyncLogRow = {
  id: string;
  at: string;
  repos: { repoId: string; name: string; count: number }[];
};
/** A favourite, either a thread or a folder. `id` = `${kind}:${ref}`. */
export type FavoriteRow = { id: string; kind: "thread" | "repo"; ref: string };
/** A permanently-hidden folder. `id` = repoId. */
export type IgnoredRepoRow = { id: string };
/** Sticky per-thread model choice. `id` = threadId. */
export type ThreadModelRow = { id: string; model: string };
/** Local presentation override for a device. `id` = deviceId. */
export type DeviceOverrideRow = { id: string; name?: string; emoji?: string };
/** A marker override. `id` = `${sessionId}|${messageId}`. */
export type MarkerRow = { id: string; marked: boolean };
/** Reported capabilities for an agent. `id` = agentId. */
export type AgentCapsRow = AgentCapabilities & { id: string };
/** Cached model catalog for a host+agent. `id` = `${hostId}:${agent}`. */
export type AgentModelsRow = { id: string; models: ModelInfo[] };
/** A persisted chat event. `id` = `${threadId}:${event.id}` (event ids are only
 *  unique within a thread, so the thread is folded into the key). The event is
 *  nested so nothing collides with the row's own id. */
export type MessageRow = { id: string; threadId: string; event: TimelineEvent };

// --- collections (each persists to its own db:* MMKV key) ---

export const devices = mmkvCollection<Device>({
  id: "devices",
  storageKey: "db:devices",
  getKey: (d) => d.id,
});
export const hosts = mmkvCollection<Host>({
  id: "hosts",
  storageKey: "db:hosts",
  getKey: (h) => h.id,
});
export const projects = mmkvCollection<Repository>({
  id: "projects",
  storageKey: "db:projects",
  getKey: (r) => r.id,
});
export const threads = mmkvCollection<Session>({
  id: "threads",
  storageKey: "db:threads",
  getKey: (s) => s.id,
});
export const recents = mmkvCollection<RecentRow>({
  id: "recents",
  storageKey: "db:recents",
  getKey: (r) => r.id,
});
export const syncLog = mmkvCollection<SyncLogRow>({
  id: "syncLog",
  storageKey: "db:syncLog",
  getKey: (e) => e.id,
});
export const favorites = mmkvCollection<FavoriteRow>({
  id: "favorites",
  storageKey: "db:favorites",
  getKey: (f) => f.id,
});
export const ignoredRepos = mmkvCollection<IgnoredRepoRow>({
  id: "ignoredRepos",
  storageKey: "db:ignoredRepos",
  getKey: (r) => r.id,
});
export const threadModels = mmkvCollection<ThreadModelRow>({
  id: "threadModels",
  storageKey: "db:threadModels",
  getKey: (t) => t.id,
});
export const deviceOverrides = mmkvCollection<DeviceOverrideRow>({
  id: "deviceOverrides",
  storageKey: "db:deviceOverrides",
  getKey: (d) => d.id,
});
export const markers = mmkvCollection<MarkerRow>({
  id: "markers",
  storageKey: "db:markers",
  getKey: (m) => m.id,
});
export const agentCaps = mmkvCollection<AgentCapsRow>({
  id: "agentCaps",
  storageKey: "db:agentCaps",
  getKey: (a) => a.id,
});
export const agentModels = mmkvCollection<AgentModelsRow>({
  id: "agentModels",
  storageKey: "db:agentModels",
  getKey: (a) => a.id,
});
export const messages = mmkvCollection<MessageRow>({
  id: "messages",
  storageKey: "db:messages",
  getKey: (m) => m.id,
});

/** Every collection, for boot-time preload. */
export const allCollections = [
  devices,
  hosts,
  projects,
  threads,
  recents,
  syncLog,
  favorites,
  ignoredRepos,
  threadModels,
  deviceOverrides,
  markers,
  agentCaps,
  agentModels,
  messages,
];

/** Hydrate every collection from MMKV before the first read/sync. Collections
 *  load lazily on first access; preloading up front keeps boot deterministic
 *  (migration + sync can read synchronously afterwards). */
export async function preloadDb(): Promise<void> {
  await Promise.all(allCollections.map((c) => c.preload()));
}

// --- low-level write ops (every collection's key IS row.id) ---

export { clearCollection, deleteIds, keyList, replaceAll, upsertRows } from "./rowWrites";
