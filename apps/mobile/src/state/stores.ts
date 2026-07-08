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
import type { ModelInfo } from "../services/bridge";
import { parseUserMessage } from "@litter/transcript";
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
  repos: string[]; // multi-select projects/folders; empty = all
  needsOnly: boolean;
  favOnly: boolean;
}>({
  device: null,
  agent: null,
  repos: [],
  needsOnly: true, // default view = what needs you
  favOnly: false,
});

/** The zero state for every filter — a single source for "Clear all". */
export const CLEARED_FILTERS = { device: null, agent: null, repos: [], needsOnly: false, favOnly: false };

/** Folders the user has permanently hidden (repoId → true). Persisted, and
 *  applied in passesFilter so ignored folders' threads never show anywhere. */
export const ignoredRepos$ = observable<Record<string, true>>({});
export const isRepoIgnored = (repoId: string): boolean => !!ignoredRepos$[repoId].get();
export function toggleRepoIgnore(repoId: string): void {
  if (ignoredRepos$[repoId].get()) {
    ignoredRepos$[repoId].delete();
  } else {
    ignoredRepos$[repoId].set(true);
    // An ignored folder shouldn't linger in the active filter selection.
    const sel = filters$.repos.get();
    if (sel.includes(repoId)) filters$.repos.set(sel.filter((id) => id !== repoId));
  }
}

/** Count of *narrowing* filters (device/agent/favourites) for the bottom bar
 *  badge. needsOnly is the default view, so it doesn't badge. */
export function activeFilterCount(): number {
  const f = filters$.get();
  return (f.device ? 1 : 0) + (f.agent ? 1 : 0) + (f.repos.length ? 1 : 0) + (f.favOnly ? 1 : 0);
}

/** Whether any filter deviates from the default view (drives "Clear all"). */
export function hasActiveFilter(): boolean {
  const f = filters$.get();
  return !!(f.agent || f.device || f.repos.length || f.needsOnly || f.favOnly);
}

/** A session that wants the user's attention (failed / awaiting input). */
export const needsYou = (s: Session): boolean =>
  s.needsAttention || s.activity === "failed" || s.activity === "awaiting_input";

/** Sort rank for a session list: attention → active → live → done. */
export function rankSession(s: Session): number {
  if (needsYou(s)) return 0;
  if (s.activity === "running" || s.activity === "streaming") return 1;
  if (s.isLive) return 2;
  return 3;
}

/** Favourited thread ids (sessionId → true). Sparse, on-device only — the bridge
 *  has no per-user store, so favourites don't sync across phones. */
export const favThreads$ = observable<Record<string, true>>({});
/** Favourited folder ids (repoId → true). */
export const favRepos$ = observable<Record<string, true>>({});

/** Last time the user *opened* each thread (sessionId → ISO). Drives the home
 *  "Jump back in" strip. Distinct from Session.updatedAt, which tracks agent
 *  activity, not user visits. */
export const recentOpens$ = observable<Record<string, string>>({});

const RECENT_OPENS_CAP = 40;

export const isFavThread = (id: string): boolean => !!favThreads$[id].get();
export const isFavRepo = (id: string): boolean => !!favRepos$[id].get();

export function toggleFavThread(id: string): void {
  if (favThreads$[id].get()) favThreads$[id].delete();
  else favThreads$[id].set(true);
}

export function toggleFavRepo(id: string): void {
  if (favRepos$[id].get()) favRepos$[id].delete();
  else favRepos$[id].set(true);
}

/** Record that the user opened a thread. Called from the session screen on mount.
 *  Trims the map to the most recent RECENT_OPENS_CAP so it can't grow unbounded. */
export function markOpened(id: string, atIso: string): void {
  const next = { ...recentOpens$.get(), [id]: atIso };
  const entries = Object.entries(next).sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]));
  recentOpens$.set(Object.fromEntries(entries.slice(0, RECENT_OPENS_CAP)));
}

/** User-selected model per thread (sessionId → model id). Sticky, on-device;
 *  passed as the turn `model` on subsequent turns until changed. */
export const threadModels$ = observable<Record<string, string>>({});
export const modelForThread = (id: string): string | undefined => threadModels$[id].get();
export function setThreadModel(id: string, model: string | null): void {
  if (model) threadModels$[id].set(model);
  else threadModels$[id].delete();
}

/** Cached model catalogs per device+agent ("hostId:agent" → models). Warmed on
 *  sync so the picker renders instantly; persisted so it survives restarts. */
export const agentModels$ = observable<Record<string, ModelInfo[]>>({});
export const modelsKey = (hostId: string, agent: string): string => `${hostId}:${agent}`;
export function cachedModels(hostId: string, agent: string): ModelInfo[] | undefined {
  return agentModels$[modelsKey(hostId, agent)].get();
}
export function setCachedModels(hostId: string, agent: string, models: ModelInfo[]): void {
  agentModels$[modelsKey(hostId, agent)].set(models);
}

/** Threads the user opened most recently, newest first, that still exist. */
export function recentSessions(): Session[] {
  const opens = recentOpens$.get();
  const sessions = sessions$.get();
  return Object.keys(opens)
    .map((id) => sessions[id])
    .filter((s): s is Session => !!s)
    .sort((a, b) => Date.parse(opens[b.id]) - Date.parse(opens[a.id]));
}

/** Marker overrides: sessionId → messageId → explicit marked state. Absent =
 *  default (user messages marked, everything else unmarked). Keyed by the
 *  route/session id, not conversationId, which can change across refetches. */
export const markers$ = observable<Record<string, Record<string, boolean>>>({});

/** A message is marked by default only if it carries prose — a plain message, or
 *  a command with an accompanying message. A bare slash command (/exit, /clear)
 *  has no text and is never auto-marked. Single source for every marker surface. */
export function defaultMarked(ev: TimelineEvent, agent?: string): boolean {
  return ev.type === "user_message" && parseUserMessage(ev.text, agent).text.trim().length > 0;
}

/** Effective marker state for a message — explicit override or the default. */
export function isMarked(sessionId: string, ev: TimelineEvent, agent?: string): boolean {
  return markers$[sessionId][ev.id].get() ?? defaultMarked(ev, agent);
}

export function toggleMarker(sessionId: string, ev: TimelineEvent, agent?: string): void {
  const next = !isMarked(sessionId, ev, agent);
  // Store only deviations from the default so the map stays sparse.
  if (next === defaultMarked(ev, agent)) markers$[sessionId][ev.id].delete();
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

/** Local per-device presentation overrides (rename + emoji), keyed by device id.
 *  Kept separate from the synced Device record — setWorkspace replaces that
 *  wholesale on every sync, so anything written onto the Device itself is wiped. */
export const deviceOverrides$ = observable<
  Record<string, { name?: string; emoji?: string }>
>({});

/** Merge a rename/emoji patch for a device; empty values clear the override. */
export function setDeviceOverride(
  id: string,
  patch: { name?: string; emoji?: string },
): void {
  const next = { ...(deviceOverrides$[id].get() ?? {}), ...patch };
  if (!next.name?.trim()) delete next.name;
  if (!next.emoji?.trim()) delete next.emoji;
  if (!next.name && !next.emoji) deviceOverrides$[id].delete();
  else deviceOverrides$[id].set(next);
}

/** Display name for a device — user override wins over the synced name. */
export function deviceLabel(id: string, fallback: string): string {
  return deviceOverrides$[id].name.get()?.trim() || fallback;
}

/** Chosen emoji for a device, if any (overrides the inferred device icon). */
export function deviceEmoji(id: string): string | undefined {
  return deviceOverrides$[id].emoji.get()?.trim() || undefined;
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
persist(favThreads$, "favThreads");
persist(favRepos$, "favRepos");
persist(filters$, "filters"); // remember the user's last filter selection
persist(ignoredRepos$, "ignoredRepos");
persist(recentOpens$, "recentOpens");
persist(threadModels$, "threadModels");
persist(agentModels$, "agentModels");
persist(user$, "user");
persist(deviceOverrides$, "deviceOverrides");

// --- selectors (respect active device/agent filters) ---

/** Dotfolders (e.g. .deepsec) are treated as hidden — never surfaced anywhere. */
const isDotName = (name: string): boolean => name.startsWith(".");

/** Build the active session predicate once (reads each observable a single time),
 *  so a full-list filter pass doesn't re-materialize the filter/ignore/repo trees
 *  per session. Reads happen in the caller's tracking scope, so it stays reactive. */
function makeSessionFilter(): (s: Session) => boolean {
  const f = filters$.get();
  const ignored = ignoredRepos$.get();
  const repos = repositories$.get();
  return (s) => {
    // Permanently-ignored folders — and hidden dotfolders — are never shown.
    if (ignored[s.repoId] || isDotName(repos[s.repoId]?.name || "")) return false;
    if (f.device && s.hostId !== f.device) return false;
    if (f.agent && s.agent !== f.agent) return false;
    if (f.repos.length && !f.repos.includes(s.repoId)) return false;
    return true;
  };
}

export function allSessions(): Session[] {
  return Object.values(sessions$.get()).filter(makeSessionFilter());
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
  return list.filter(makeSessionFilter());
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
  // Folder options are scoped by the OTHER active filters (device/agent) but must
  // ignore the folder selection itself — like availableAgents/availableDevices do
  // for their own dimension. Deriving from allSessions() (which applies f.repos)
  // collapses the option list to the one selected folder, so the whole PROJECT
  // section disappears after a single pick, trapping the user with a filter they
  // can no longer see or clear.
  const withSessions = f.device || f.agent
    ? new Set(
        Object.values(sessions$.get())
          .filter((s) => (!f.device || s.hostId === f.device) && (!f.agent || s.agent === f.agent))
          .map((s) => s.repoId),
      )
    : null;
  return Object.values(repositories$.get())
    .filter((r) => !isDotName(r.name) && (!withSessions || withSessions.has(r.id)))
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
