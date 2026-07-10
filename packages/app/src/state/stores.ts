/**
 * Global state — Legend State, persisted to MMKV. The model is repo → session.
 */
import { observable } from "@legendapp/state";
import type {
  AgentCapabilities,
  Device,
  Host,
  PermissionMode,
  Repository,
  RunImage,
  Session,
  TimelineEvent,
  UserProfile,
} from "@litter/shared";
import { persist } from "../services/persistence";

export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting";

export const hosts$ = observable<Record<string, Host>>({});
export const devices$ = observable<Record<string, Device>>({});
export const repositories$ = observable<Record<string, Repository>>({});
export const sessions$ = observable<Record<string, Session>>({});

/** Per-agent capabilities reported by connected devices (agentId → caps). */
export const agentCaps$ = observable<Record<string, AgentCapabilities>>({});

/** First turn for a freshly-created session, fired once when its screen opens.
 *  Lets the New-task composer hand off to the session view (transient). */
export interface PendingTurn {
  text: string;
  images: RunImage[];
  permissionMode?: PermissionMode;
  reasoningEffort?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
}
export const pendingTurns$ = observable<Record<string, PendingTurn>>({});

/** Active filters for the Home list. null = all. */
export const filters$ = observable<{
  device: string | null;
  agent: string | null;
  needsOnly: boolean;
}>({
  device: null,
  agent: null,
  needsOnly: true, // default view = what needs you
});

/** Count of *narrowing* filters (device/agent) for the bottom bar badge.
 *  needsOnly is the default view, so it doesn't badge. */
export function activeFilterCount(): number {
  const f = filters$.get();
  return (f.device ? 1 : 0) + (f.agent ? 1 : 0);
}

/** Marker overrides: sessionId → messageId → explicit marked state. Absent =
 *  default (user messages marked, everything else unmarked). Keyed by the
 *  route/session id, not conversationId, which can change across refetches. */
export const markers$ = observable<Record<string, Record<string, boolean>>>({});

/** Effective marker state for a message — explicit override or the default. */
export function isMarked(sessionId: string, ev: TimelineEvent): boolean {
  return markers$[sessionId][ev.id].get() ?? ev.type === "user_message";
}

export function toggleMarker(sessionId: string, ev: TimelineEvent): void {
  const next = !isMarked(sessionId, ev);
  const def = ev.type === "user_message";
  // Store only deviations from the default so the map stays sparse.
  if (next === def) markers$[sessionId][ev.id].delete();
  else markers$[sessionId][ev.id].set(next);
}

/** One sync event: which repos got new or newly-active sessions, and how many.
 *  Powers the Sync history screen — a per-repo record of when agent activity
 *  actually reached this device. */
export interface SyncLogEntry {
  /** ISO timestamp of the sync. */
  at: string;
  /** Repos that changed this sync, busiest first. */
  repos: { repoId: string; name: string; count: number }[];
}
export const syncLog$ = observable<SyncLogEntry[]>([]);

const SYNC_LOG_CAP = 100;

/** Diff a fresh sync against the previous session map; if any session is new or
 *  newly-active (its updatedAt advanced), append a timestamped entry grouped by
 *  repo. No-op when nothing changed, so a plain refresh doesn't log noise.
 *  There's no backfill — logging starts from the first sync after install. */
export function recordSync(
  prev: Record<string, Session>,
  next: Record<string, Session>,
  repos: Record<string, Repository>,
  at: string,
): void {
  const counts = new Map<string, number>();
  for (const [id, s] of Object.entries(next)) {
    const before = prev[id];
    if (!before || before.updatedAt !== s.updatedAt) {
      counts.set(s.repoId, (counts.get(s.repoId) ?? 0) + 1);
    }
  }
  if (counts.size === 0) return;
  const entry: SyncLogEntry = {
    at,
    repos: [...counts.entries()]
      .map(([repoId, count]) => ({
        repoId,
        name: repos[repoId]?.name ?? repoId.replace(/^repo:/, ""),
        count,
      }))
      .sort((a, b) => b.count - a.count),
  };
  syncLog$.set([entry, ...syncLog$.get()].slice(0, SYNC_LOG_CAP));
}

export const user$ = observable<UserProfile>({
  id: "local",
  displayName: "You",
  defaultAgent: "claude",
  theme: "dark",
});

export const connection$ = observable<{
  status: ConnectionStatus;
  activeHostId: string | null;
  demo: boolean;
}>({ status: "disconnected", activeHostId: null, demo: false });

persist(hosts$, "hosts");
persist(devices$, "devices");
persist(agentCaps$, "agentCaps");
persist(repositories$, "repositories");
persist(sessions$, "sessions");
persist(syncLog$, "syncLog");
persist(markers$, "markers");
persist(user$, "user");

// --- selectors (respect active device/agent filters) ---

function passesFilter(s: Session): boolean {
  const f = filters$.get();
  if (f.device && s.hostId !== f.device) return false;
  if (f.agent && s.agent !== f.agent) return false;
  return true;
}

export function allSessions(): Session[] {
  return Object.values(sessions$.get()).filter(passesFilter);
}

export function sessionsForRepo(repoId: string): Session[] {
  return allSessions()
    .filter((s) => s.repoId === repoId)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

export function attentionSessions(): Session[] {
  return allSessions()
    .filter((s) => s.needsAttention)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

export function allDevices(): Device[] {
  return Object.values(devices$.get());
}

/** Mark every known device offline. `online` is live connectivity, not state to
 *  trust across launches — a successful sync flips reachable ones back on. Call
 *  this at boot so a device paired in a past session doesn't show a green
 *  "connected" dot before we've actually reached its host this session. */
export function markDevicesOffline(): void {
  const cur = devices$.get();
  const next: Record<string, Device> = {};
  for (const [id, d] of Object.entries(cur)) next[id] = { ...d, online: false };
  devices$.set(next);
}

/** Drop a device from the live stores (its config is removed separately via
 *  removeDeviceConfig). Clears both the device row and its host entry. */
export function forgetDevice(id: string): void {
  devices$[id].delete();
  hosts$[id].delete();
}

export function allAgentsInUse(): string[] {
  return [...new Set(Object.values(sessions$.get()).map((s) => s.agent))].sort();
}

/** Capabilities reported for an agent (null if unknown — caller falls back). */
export function capsFor(agent: string): AgentCapabilities | null {
  return agentCaps$[agent].get() ?? null;
}

/** All sessions, unfiltered — the basis for computing smart filter options. */
export function rawSessions(): Session[] {
  return Object.values(sessions$.get());
}

/** Apply the active device/agent filters to an arbitrary session list. */
export function applyFilters(list: Session[]): Session[] {
  return list.filter(passesFilter);
}

// --- smart (dependent) filter options ---
// Options are derived from a `scope` (the sessions visible in the current
// view/section) and cross-filtered: the agent options respect the selected
// device and vice-versa, so picking a device narrows the agent list to what
// actually runs there.

/** Distinct devices that have a session in `scope`, ignoring filters. */
export function devicesInScope(scope: Session[]): Device[] {
  const map = devices$.get();
  const ids = new Set(scope.map((s) => s.hostId));
  return [...ids].map((id) => map[id]).filter(Boolean);
}

/** Distinct agents present in `scope`, ignoring filters. */
export function agentsInScope(scope: Session[]): string[] {
  return [...new Set(scope.map((s) => s.agent))].sort();
}

/** Agents in `scope` available given the selected device (ignores agent filter). */
export function availableAgents(scope: Session[]): string[] {
  const dev = filters$.device.get();
  const set = new Set<string>();
  for (const s of scope) if (!dev || s.hostId === dev) set.add(s.agent);
  return [...set].sort();
}

/** Devices in `scope` available given the selected agent (ignores device filter). */
export function availableDevices(scope: Session[]): Device[] {
  const ag = filters$.agent.get();
  const map = devices$.get();
  const ids = new Set<string>();
  for (const s of scope) if (!ag || s.agent === ag) ids.add(s.hostId);
  return [...ids].map((id) => map[id]).filter(Boolean);
}

export function reposByActivity(): Repository[] {
  const f = filters$.get();
  const withSessions = f.device || f.agent
    ? new Set(allSessions().map((s) => s.repoId))
    : null;
  return Object.values(repositories$.get())
    .filter((r) => !withSessions || withSessions.has(r.id))
    .sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt));
}

/** Replace all repos/sessions atomically (used by live sync + demo seed). */
export function setWorkspace(
  repos: Record<string, Repository>,
  sessions: Record<string, Session>,
  devices?: Record<string, Device>,
): void {
  repositories$.set(repos);
  sessions$.set(sessions);
  if (devices) devices$.set(devices);
}
