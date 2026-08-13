/**
 * State layer. The relational model (devices → projects → threads → chats, plus
 * recents/sync-history/favourites) lives in @tanstack/react-db collections
 * (see ./db/collections). This module holds:
 *   - the few pure-UI singletons that aren't relational (filters, connection,
 *     pending turns, user profile), still in Legend State;
 *   - pure derivation helpers (filtering/ranking) that take data as arguments;
 *   - every write op over the collections (sync, cascade-delete, favourites, …).
 * Reactive reads for components live in ./db/hooks (useLiveQuery wrappers).
 */
import { observable } from "@legendapp/state";
import type {
  ActivityStatus,
  PermissionMode,
  Repository,
  RunImage,
  Session,
  TimelineEvent,
  UserProfile,
} from "@pounce/shared";
import type { AgentCapabilities } from "@pounce/shared";
import type { Device, Host } from "@pounce/shared";
import { parseUserMessage } from "@pounce/transcript";
import type { ModelInfo } from "../services/bridge";
import { persist } from "../services/persistence";
import { DEFAULT_SHOW, isDotName, showNarrowed, type ShowBucket } from "./sessionRules";
import {
  agentCaps,
  agentModels,
  clearCollection,
  deleteIds,
  deviceOverrides,
  devices,
  favorites,
  hosts,
  ignoredRepos,
  keyList,
  markers,
  messages,
  projects,
  recents,
  replaceAll,
  syncLog,
  threadModels,
  threads,
  upsertRows,
} from "./db/collections";

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "reconnecting";

// --- Legend State singletons (pure UI / ephemeral — not relational) ---

/** First turn for a freshly-created session, fired once when its screen opens. */
export interface PendingTurn {
  text: string;
  images: RunImage[];
  permissionMode?: PermissionMode;
  reasoningEffort?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  /**
   * The model picked on the New screen, carried on the turn itself.
   *
   * It is ALSO written to `threadModels` (which is what every later turn in the
   * thread reads, and what survives the new_ -> real id rekey). But that write
   * is a collection commit and the first turn fires a frame later, before it is
   * readable — so the thread's own pill showed the right model while the turn
   * had already gone out on the agent's default. The first turn is the one
   * moment the store can't answer for, so the turn carries the answer.
   */
  model?: string | null;
}
export const pendingTurns$ = observable<Record<string, PendingTurn>>({});

/** Coarse status buckets for the Home/Search status filter. Every activity maps
 *  to exactly one bucket: `active` = a turn in flight, `idle` = live but no turn,
 *  `done` = the turn ended (success or failure). See {@link statusBucket}. */
export type StatusBucket = "active" | "idle" | "done";

/** Active filters for the Home list. null = all. */
export const filters$ = observable<{
  device: string | null;
  agent: string | null;
  repos: string[]; // multi-select folders; empty = all
  statuses: StatusBucket[]; // multi-select status buckets; empty = all
  branchQuery: string; // substring match over branch + worktree; "" = all
  favOnly: boolean;
  /** Which of the three thread buckets to include — see {@link ShowBucket}. */
  show: ShowBucket[];
}>({
  device: null,
  agent: null,
  repos: [],
  statuses: [],
  branchQuery: "",
  favOnly: false,
  show: [...DEFAULT_SHOW],
});

/** The zero state for every filter — a single source for "Clear all". */
export const CLEARED_FILTERS = {
  device: null,
  agent: null,
  repos: [],
  statuses: [],
  branchQuery: "",
  favOnly: false,
  show: [...DEFAULT_SHOW],
};

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

/** A file/folder the user attached to a thread as context (drag-drop on
 *  desktop, "+" in the Environment sheet). Referenced by path — the agent
 *  reads it from disk, so only the reference is stored. */
export interface ThreadSource {
  path: string;
  name: string;
  kind: "file" | "dir" | "image";
}
/** Sources per thread id. Persisted so the Environment panel survives restarts. */
export const sources$ = observable<Record<string, ThreadSource[]>>({});

/** Add sources to a thread, deduped by path. Returns the newly-added ones. */
export function addSources(threadId: string, incoming: ThreadSource[]): ThreadSource[] {
  const cur = sources$[threadId].get() ?? [];
  const seen = new Set(cur.map((s) => s.path));
  const fresh = incoming.filter((s) => !seen.has(s.path));
  if (fresh.length) sources$[threadId].set([...cur, ...fresh]);
  return fresh;
}

export function removeSource(threadId: string, path: string): void {
  const cur = sources$[threadId].get() ?? [];
  sources$[threadId].set(cur.filter((s) => s.path !== path));
}

/** Move a thread's per-id observable state to a new id (temp id → real id),
 *  and drop entries for threads that no longer exist. Shared by rekeyThread
 *  and cascadeCleanup so sources/seen-files can't orphan in MMKV. */
function rekeyThreadObservables(oldId: string, newId: string): void {
  // Cast per store: the two observables' union collapses .set()'s signatures.
  for (const store$ of [sources$, seenFiles$].map((s) => s as typeof sources$)) {
    const v = store$[oldId].get();
    if (v?.length) store$[newId].set(v);
    store$[oldId].delete();
  }
  // Interactive marker (a boolean map, not an array) — carry it across the swap.
  if (interactiveThreads$[oldId].get()) interactiveThreads$[newId].set(true);
  interactiveThreads$[oldId].delete();
}

function sweepThreadObservables(liveThreadIds: ReadonlySet<string>): void {
  for (const store$ of [sources$, seenFiles$]) {
    for (const id of Object.keys(store$.get() ?? {})) {
      if (!liveThreadIds.has(id)) store$[id].delete();
    }
  }
  for (const id of Object.keys(interactiveThreads$.get() ?? {})) {
    if (!liveThreadIds.has(id)) interactiveThreads$[id].delete();
  }
}

/** Diff files marked "Seen" per thread — Changes-screen review progress
 *  (GitHub PR style). Persisted so seen files come back collapsed. */
export const seenFiles$ = observable<Record<string, string[]>>({});

export function setSeenFile(threadId: string, path: string, seen: boolean): void {
  const cur = seenFiles$[threadId].get() ?? [];
  const next = seen ? [...new Set([...cur, path])] : cur.filter((p) => p !== path);
  seenFiles$[threadId].set(next);
}

/** Threads the user launched as PTY-hosted interactive (answerable) sessions.
 *  Their composer follow-ups route back through the interactive path — the
 *  bridge reuses the live PTY or `--resume`s the SAME session — instead of a
 *  fresh headless turn, so a test thread stays one thread and its prompts stay
 *  answerable. Persisted so the routing survives restarts. */
export const interactiveThreads$ = observable<Record<string, true>>({});

/** Route aliases for threads re-keyed mid-visit (temporary new_* → the real id
 *  the daemon assigned after the first turn). The open Session screen resolves
 *  its route param through this so it can follow the swap in place — replacing
 *  the route instead remounts the screen and visibly blanks the timeline right
 *  as the reply finishes. In-memory only: stale new_* routes don't survive an
 *  app restart. */
export const rekeyedThreadIds$ = observable<Record<string, string>>({});

/** Mark a thread as interactive (called when it's launched from New → Interactive). */
export function markInteractive(threadId: string): void {
  interactiveThreads$[threadId].set(true);
}

/** Whether a thread's follow-ups should drive the interactive PTY path. */
export function isThreadInteractive(threadId: string): boolean {
  return !!interactiveThreads$[threadId].get();
}

/** The interactive prompt a thread is currently blocked on, as last seen by the
 *  message poll — drives the auto-presented prompt form sheet. Transient (never
 *  persisted): on relaunch the poll re-detects a still-open prompt within one
 *  cycle, and a stale entry would present a sheet for a prompt long resolved. */
export interface PendingPrompt {
  readonly promptId: string;
  readonly title: string;
  readonly kind: string; // "trust" | "permission" | "plan" | "prompt"
  readonly options: readonly { readonly label: string }[];
  readonly highlighted: number;
  readonly multiSelect: boolean;
  readonly hostId: string;
  readonly threadId: string;
}

export const pendingPrompts$ = observable<Record<string, PendingPrompt | undefined>>({});

export function setPendingPrompt(p: PendingPrompt): void {
  // Same promptId → same prompt still on screen; don't churn subscribers.
  if (pendingPrompts$[p.threadId].peek()?.promptId === p.promptId) return;
  pendingPrompts$[p.threadId].set(p);
}

export function clearPendingPrompt(threadId: string): void {
  if (pendingPrompts$[threadId].peek()) pendingPrompts$[threadId].delete();
}

persist(filters$, "filters"); // remember the user's last filter selection
/**
 * Repair `show` after hydration.
 *
 * Every installed copy of the app persisted this object BEFORE `show` existed
 * (it held a `needsOnly` boolean instead), and a hydrated value that predates a
 * field leaves it undefined rather than falling back to the initial value.
 * Undefined here is not a cosmetic bug: every screen reads `show` to decide
 * which threads exist, so the first launch after upgrading would render an
 * empty list with no filter badge and nothing to click.
 *
 * An EMPTY array gets the same repair. The sheet stops you removing the last
 * bucket, so empty can only arrive from old or corrupted state — and "the user
 * asked to see nothing at all" is never the likelier reading.
 *
 * Deliberately does NOT carry the old `needsOnly: true` across: that flag meant
 * "show me only what needs you", which was the default nobody chose, and the
 * new default shows strictly more.
 */
{
  const show = filters$.show.peek();
  if (!Array.isArray(show) || show.length === 0) filters$.show.set([...DEFAULT_SHOW]);
}
persist(user$, "user");
persist(sources$, "sources");
persist(seenFiles$, "seenFiles");
persist(interactiveThreads$, "interactiveThreads");

/** Count of *narrowing* filters (device/agent/status/branch/favourites/show) for
 *  the badge. Show counts whenever it isn't the default pair: it is the filter
 *  that changes WHICH THREADS EXIST for the screen rather than trimming the ones
 *  already there, so a user who left the archive on — or dropped a bucket — and
 *  later wonders where their work went has a badge pointing at the answer. */
export function activeFilterCount(): number {
  const f = filters$.get();
  return (
    (f.device ? 1 : 0) +
    (f.agent ? 1 : 0) +
    (f.repos.length ? 1 : 0) +
    (f.statuses.length ? 1 : 0) +
    (f.branchQuery.trim() ? 1 : 0) +
    (f.favOnly ? 1 : 0) +
    (showNarrowed(f.show) ? 1 : 0)
  );
}

/** Whether any filter deviates from the default view (drives "Clear all"). */
export function hasActiveFilter(): boolean {
  const f = filters$.get();
  return !!(
    f.agent ||
    f.device ||
    f.repos.length ||
    f.statuses.length ||
    f.branchQuery.trim() ||
    f.favOnly ||
    showNarrowed(f.show)
  );
}

// --- pure helpers (operate on plain data, no store reads) ---

// The session predicates live in ./sessionRules so they can be imported without
// this module's persistence layer. Imported for use below AND re-exported from
// source, as two statements: `export { x }` over an imported binding compiles to
// a getter over a local that doesn't exist once Metro rewrites the module, which
// typechecks cleanly and then throws at runtime.
export {
  DEFAULT_SHOW,
  isDotName,
  needsYou,
  rankSession,
  recentlyActive,
  showBucket,
  showNarrowed,
  type ShowBucket,
} from "./sessionRules";

/** Every activity collapses into one coarse bucket for the status filter. */
const STATUS_BUCKET: Record<ActivityStatus, StatusBucket> = {
  running: "active",
  streaming: "active",
  queued: "active",
  awaiting_input: "active",
  idle: "idle",
  completed: "done",
  failed: "done",
};

/** The coarse status bucket a session falls in (drives the status filter). */
export function statusBucket(s: Session): StatusBucket {
  return STATUS_BUCKET[s.activity];
}

/** A message is marked by default if it carries prose — and an interactive
 *  prompt (trust / permission / plan / question) is ALWAYS marked, so a prompt
 *  the agent is blocked on is a jump-to point you can always find.
 *  "[Request interrupted by user]" is a CLI-written artifact, not something
 *  the user said — never a marker. */
export function defaultMarked(ev: TimelineEvent, agent?: string): boolean {
  if (ev.type === "prompt_request") return true;
  if (ev.type !== "user_message") return false;
  if (/^\s*\[Request interrupted by user/i.test(ev.text)) return false;
  return parseUserMessage(ev.text, agent).text.trim().length > 0;
}

export interface FilterContext {
  filters: {
    device: string | null;
    agent: string | null;
    repos: string[];
    statuses?: StatusBucket[];
    branchQuery?: string;
  };
  ignored: Set<string>;
  repoName: (repoId: string) => string;
}

/** The active-session predicate, made from plain data so a full-list pass doesn't
 *  re-read any store per session. Ignored/dotfolders never show; device/agent/repo/
 *  status/branch filters narrow. */
export function passesFilter(s: Session, ctx: FilterContext): boolean {
  if (ctx.ignored.has(s.repoId) || isDotName(ctx.repoName(s.repoId))) return false;
  if (ctx.filters.device && s.hostId !== ctx.filters.device) return false;
  if (ctx.filters.agent && s.agent !== ctx.filters.agent) return false;
  if (ctx.filters.repos.length && !ctx.filters.repos.includes(s.repoId)) return false;
  if (ctx.filters.statuses?.length && !ctx.filters.statuses.includes(statusBucket(s))) return false;
  const bq = ctx.filters.branchQuery?.trim().toLowerCase();
  if (bq && !`${s.branch ?? ""} ${s.worktree ?? ""}`.toLowerCase().includes(bq)) return false;
  return true;
}

export function applyFilters(list: Session[], ctx: FilterContext): Session[] {
  return list.filter((s) => passesFilter(s, ctx));
}

/** Distinct devices that have a session in `scope`. */
export function devicesInScope(scope: Session[], byId: Record<string, Device>): Device[] {
  const ids = new Set(scope.map((s) => s.hostId));
  return [...ids].map((id) => byId[id]).filter(Boolean);
}

/** Distinct agents present in `scope`. */
export function agentsInScope(scope: Session[]): string[] {
  return [...new Set(scope.map((s) => s.agent))].sort();
}

/** Agents in `scope` given the selected device (ignores the agent filter). */
export function availableAgents(scope: Session[], deviceFilter: string | null): string[] {
  const set = new Set<string>();
  for (const s of scope) if (!deviceFilter || s.hostId === deviceFilter) set.add(s.agent);
  return [...set].sort();
}

// Pure agent/branch scoping helpers live in a dependency-free leaf so they're
// unit-testable without the MMKV-backed stores; re-exported here for callers.
export { availAgentsForDevices, branchesInScope, sortAgents } from "./agentScope";

/** Devices in `scope` given the selected agent (ignores the device filter). */
export function availableDevices(
  scope: Session[],
  agentFilter: string | null,
  byId: Record<string, Device>,
): Device[] {
  const ids = new Set<string>();
  for (const s of scope) if (!agentFilter || s.agent === agentFilter) ids.add(s.hostId);
  return [...ids].map((id) => byId[id]).filter(Boolean);
}

/** Folders ordered by recent activity, scoped by the OTHER active filters. */
export function reposByActivity(
  repos: Repository[],
  sessions: Session[],
  filters: { device: string | null; agent: string | null },
): Repository[] {
  const withSessions =
    filters.device || filters.agent
      ? new Set(
          sessions
            .filter(
              (s) =>
                (!filters.device || s.hostId === filters.device) &&
                (!filters.agent || s.agent === filters.agent),
            )
            .map((s) => s.repoId),
        )
      : null;
  return repos
    .filter((r) => !isDotName(r.name) && (!withSessions || withSessions.has(r.id)))
    .sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt));
}

// --- synchronous collection reads (for services / non-reactive callers) ---

export const modelsKey = (hostId: string, agent: string): string => `${hostId}:${agent}`;

export function cachedModels(hostId: string, agent: string): ModelInfo[] | undefined {
  return agentModels.get(modelsKey(hostId, agent))?.models;
}

export function capsFor(agent: string): AgentCapabilities | null {
  return agentCaps.get(agent) ?? null;
}

export function modelForThread(id: string): string | undefined {
  return threadModels.get(id)?.model;
}

export function isFavThread(id: string): boolean {
  return favorites.has(`thread:${id}`);
}
export function isFavRepo(id: string): boolean {
  return favorites.has(`repo:${id}`);
}
export function isRepoIgnored(repoId: string): boolean {
  return ignoredRepos.has(repoId);
}

/** Effective marker state for a message — explicit override or the default. */
export function isMarked(sessionId: string, ev: TimelineEvent, agent?: string): boolean {
  return markers.get(`${sessionId}|${ev.id}`)?.marked ?? defaultMarked(ev, agent);
}

/** Display name for a device — user override wins over the synced name. */
export function deviceLabel(id: string, fallback: string): string {
  return deviceOverrides.get(id)?.name?.trim() || fallback;
}
/** Chosen emoji for a device, if any. */
export function deviceEmoji(id: string): string | undefined {
  return deviceOverrides.get(id)?.emoji?.trim() || undefined;
}

// --- write ops (mutations over collections) ---

const RECENT_OPENS_CAP = 40;

/** Record that the user opened a thread; trims to the most recent N. */
export function markOpened(id: string, atIso: string): void {
  if (recents.has(id)) recents.update(id, (d) => void (d.openedAt = atIso));
  else recents.insert([{ id, openedAt: atIso }]);
  const all = recents.toArray.sort((a, b) => Date.parse(b.openedAt) - Date.parse(a.openedAt));
  const overflow = all.slice(RECENT_OPENS_CAP).map((r) => r.id);
  if (overflow.length) recents.delete(overflow);
}

export function toggleFavThread(id: string): void {
  const key = `thread:${id}`;
  if (favorites.has(key)) favorites.delete(key);
  else favorites.insert([{ id: key, kind: "thread", ref: id }]);
}
export function toggleFavRepo(id: string): void {
  const key = `repo:${id}`;
  if (favorites.has(key)) favorites.delete(key);
  else favorites.insert([{ id: key, kind: "repo", ref: id }]);
}

export function toggleRepoIgnore(repoId: string): void {
  if (ignoredRepos.has(repoId)) {
    ignoredRepos.delete(repoId);
  } else {
    ignoredRepos.insert([{ id: repoId }]);
    // An ignored folder shouldn't linger in the active filter selection.
    const sel = filters$.repos.get();
    if (sel.includes(repoId)) filters$.repos.set(sel.filter((id) => id !== repoId));
  }
}

export function setThreadModel(id: string, model: string | null): void {
  if (model) upsertRows(threadModels, [{ id, model }]);
  else if (threadModels.has(id)) threadModels.delete(id);
}

export function setCachedModels(hostId: string, agent: string, models: ModelInfo[]): void {
  upsertRows(agentModels, [{ id: modelsKey(hostId, agent), models }]);
}

export function setAgentCaps(agentId: string, caps: AgentCapabilities): void {
  upsertRows(agentCaps, [{ ...caps, id: agentId }]);
}

/** Flip a marker locally. Returns the override that now applies, or null when
 *  the toggle landed back on the default and the override was dropped — the
 *  caller mirrors exactly that to the bridge (see `pushMarker`). This module
 *  stays free of service imports: services/bridge already imports from here, so
 *  reaching back would close a require cycle. */
export function toggleMarker(sessionId: string, ev: TimelineEvent, agent?: string): boolean | null {
  const key = `${sessionId}|${ev.id}`;
  const next = !isMarked(sessionId, ev, agent);
  // Store only deviations from the default so the collection stays sparse.
  if (next === defaultMarked(ev, agent)) {
    if (markers.has(key)) markers.delete(key);
    return null;
  }
  upsertRows(markers, [{ id: key, marked: next }]);
  return next;
}

/** Merge overrides the bridge holds (made on another device) into the local
 *  collection. ADDITIVE ONLY: an override this device already has wins, so a
 *  stale or partial read can never silently undo a local marker. */
export function mergeRemoteMarkers(
  sessionId: string,
  remote: { eventId: string; marked: boolean }[],
): void {
  const rows = remote
    .filter((r) => r?.eventId && !markers.has(`${sessionId}|${r.eventId}`))
    .map((r) => ({ id: `${sessionId}|${r.eventId}`, marked: !!r.marked }));
  if (rows.length) upsertRows(markers, rows);
}

/** Merge a rename/emoji patch for a device; empty values clear the override. */
export function setDeviceOverride(id: string, patch: { name?: string; emoji?: string }): void {
  const cur = deviceOverrides.get(id) ?? { id };
  const next: { id: string; name?: string; emoji?: string } = { ...cur, ...patch, id };
  if (!next.name?.trim()) delete next.name;
  if (!next.emoji?.trim()) delete next.emoji;
  if (!next.name && !next.emoji) {
    if (deviceOverrides.has(id)) deviceOverrides.delete(id);
  } else {
    upsertRows(deviceOverrides, [next]);
  }
}

/** Mark every known device offline (called at boot before a live sync proves reach). */
export function markDevicesOffline(): void {
  for (const id of keyList(devices)) {
    if (devices.get(id)?.online) devices.update(id, (d) => void (d.online = false));
  }
}

// --- sync-history ---

export interface SyncLogEntry {
  at: string;
  repos: { repoId: string; name: string; count: number }[];
}

const SYNC_LOG_CAP = 100;

/** Append a sync-history entry from the diff of previous vs next threads. No-op
 *  when nothing changed. Trims to the most recent N. */
function recordSync(
  prev: Map<string, Session>,
  next: Session[],
  reposById: Record<string, Repository>,
  at: string,
): void {
  const counts = new Map<string, number>();
  for (const s of next) {
    const before = prev.get(s.id);
    if (!before || before.updatedAt !== s.updatedAt) {
      counts.set(s.repoId, (counts.get(s.repoId) ?? 0) + 1);
    }
  }
  if (counts.size === 0) return;
  const repos = [...counts.entries()]
    .map(([repoId, count]) => ({
      repoId,
      name: reposById[repoId]?.name ?? repoId.replace(/^repo:/, ""),
      count,
    }))
    .sort((a, b) => b.count - a.count);
  syncLog.insert([{ id: `${at}:${Math.random().toString(36).slice(2, 8)}`, at, repos }]);
  const overflow = syncLog.toArray
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(SYNC_LOG_CAP)
    .map((e) => e.id);
  if (overflow.length) syncLog.delete(overflow);
}

// --- messages (chat history) ---

const MESSAGES_PER_THREAD_CAP = 500;

/**
 * What we last wrote for a thread — `count:lastEventId`.
 *
 * The collection persists by serialising ITSELF WHOLE to one MMKV key, so every
 * touch costs a JSON.stringify of every message of every thread. The screen
 * re-saves whenever a query's data object changes identity, and the "recent"
 * query refetches every 2.5s during a live turn — so a long thread was
 * re-serialising megabytes on the JS thread every few seconds, and new messages
 * appeared late because that thread was busy. Transcripts are append-only, so
 * count-plus-last-id is enough to recognise "nothing new" and skip the write.
 */
const lastSaved = new Map<string, string>();

/** Persist a batch of chat events for a thread (upsert by event id) and trim the
 *  oldest beyond a per-thread cap so history can't grow unbounded. Called on
 *  turn completion / after a full re-fetch — never per streamed event, so the
 *  whole-collection localStorage write fires once per turn, not per token. */
export function saveThreadMessages(threadId: string, events: TimelineEvent[]): void {
  if (events.length === 0) return;
  const sig = `${events.length}:${events[events.length - 1]?.id ?? ""}`;
  if (lastSaved.get(threadId) === sig) return;
  lastSaved.set(threadId, sig);

  upsertRows(
    messages,
    events.map((e) => ({ id: `${threadId}:${e.id}`, threadId, event: e })),
  );
  // Only walk the collection when this thread can actually be over the cap.
  // `toArray` materialises EVERY row of EVERY thread, so doing it on each save
  // was an O(all messages) scan plus a sort for, almost always, no deletions.
  if (events.length < MESSAGES_PER_THREAD_CAP) return;
  const mine = messages.toArray
    .filter((m) => m.threadId === threadId)
    .sort((a, b) => (a.event.ts ?? "").localeCompare(b.event.ts ?? ""));
  const overflow = mine
    .slice(0, Math.max(0, mine.length - MESSAGES_PER_THREAD_CAP))
    .map((m) => m.id);
  if (overflow.length) messages.delete(overflow);
}

/** Forget a thread's write signature — call when its rows are dropped, so the
 *  next save isn't skipped as a duplicate of history that no longer exists. */
function forgetSaved(threadId: string): void {
  lastSaved.delete(threadId);
}

/** Delete every chat event belonging to a thread. */
export function dropThreadMessages(threadId: string): void {
  forgetSaved(threadId);
  const ids = messages.toArray.filter((m) => m.threadId === threadId).map((m) => m.id);
  deleteIds(messages, ids);
}

/** Earliest persisted user-message text per thread (by daemon `seq`). Lets a
 *  thread the daemon gave no preview borrow a title from its first message —
 *  using only local, already-synced data (no per-thread fetch), recomputed each
 *  sync so it's deterministic and never fights the sync writer. */
export function firstUserMessages(): Map<string, { seq: number; text: string }> {
  const best = new Map<string, { seq: number; text: string }>();
  for (const m of messages.toArray) {
    const ev = m.event;
    if (ev.type !== "user_message" || typeof ev.text !== "string" || !ev.text.trim()) continue;
    const cur = best.get(m.threadId);
    if (!cur || ev.seq < cur.seq) best.set(m.threadId, { seq: ev.seq, text: ev.text });
  }
  return best;
}

// --- optimistic thread writes (new-task composer, session re-key) ---

/** Insert a locally-created thread (optimistic, before the first turn lands). */
export function insertThread(s: Session): void {
  upsertRows(threads, [s]);
}

/** Re-key a freshly-created thread to its real id once the daemon assigns one:
 *  drop the temporary row, insert the real one, and carry over any recents /
 *  favourite / model / marker state so nothing is lost across the swap. */
export function rekeyThread(oldId: string, s: Session): void {
  rekeyedThreadIds$[oldId].set(s.id);
  if (threads.has(oldId)) threads.delete(oldId);
  upsertRows(threads, [s]);
  if (recents.has(oldId)) {
    const openedAt = recents.get(oldId)?.openedAt;
    recents.delete(oldId);
    if (openedAt) upsertRows(recents, [{ id: s.id, openedAt }]);
  }
  if (favorites.has(`thread:${oldId}`)) {
    favorites.delete(`thread:${oldId}`);
    upsertRows(favorites, [{ id: `thread:${s.id}`, kind: "thread", ref: s.id }]);
  }
  const model = threadModels.get(oldId)?.model;
  if (model) {
    threadModels.delete(oldId);
    upsertRows(threadModels, [{ id: s.id, model }]);
  }
  rekeyThreadObservables(oldId, s.id);
}

/** Delete one thread and its dependent rows. */
export function deleteThread(id: string): void {
  if (threads.has(id)) threads.delete(id);
  dropThreadMessages(id);
  cascadeCleanup();
}

// --- referential-integrity cascade ---

/** Drop every dependent row that now points at a thread/repo/host/agent that no
 *  longer exists. The cascade react-db doesn't enforce for us — but centralized
 *  and driven off the current threads/projects, so every removal path converges
 *  to a consistent store. */
export function cascadeCleanup(): void {
  const threadList = threads.toArray;
  const liveThreadIds = new Set(threadList.map((s) => s.id));
  const liveRepoIds = new Set(threadList.map((s) => s.repoId));
  const liveHostIds = new Set(threadList.map((s) => s.hostId));
  const liveAgents = new Set<string>(threadList.map((s) => s.agent));

  // Projects with no remaining thread.
  deleteIds(
    projects,
    projects.toArray.filter((r) => !liveRepoIds.has(r.id)).map((r) => r.id),
  );

  // Per-thread state.
  sweepThreadObservables(liveThreadIds);
  deleteIds(
    recents,
    recents.toArray.filter((r) => !liveThreadIds.has(r.id)).map((r) => r.id),
  );
  deleteIds(
    threadModels,
    threadModels.toArray.filter((t) => !liveThreadIds.has(t.id)).map((t) => t.id),
  );
  deleteIds(
    markers,
    markers.toArray.filter((m) => !liveThreadIds.has(m.id.split("|")[0])).map((m) => m.id),
  );
  // favourites: threads must still exist; repo favourites tolerated only if the repo does.
  deleteIds(
    favorites,
    favorites.toArray
      .filter((f) => (f.kind === "thread" ? !liveThreadIds.has(f.ref) : !liveRepoIds.has(f.ref)))
      .map((f) => f.id),
  );
  // messages for dead threads.
  deleteIds(
    messages,
    messages.toArray.filter((m) => !liveThreadIds.has(m.threadId)).map((m) => m.id),
  );

  // Per-host / per-agent caches. agentModels keys are `${hostId}:${agent}` and
  // hostId itself contains a colon (dev:…), so split on the LAST colon.
  deleteIds(
    agentModels,
    agentModels.toArray
      .filter((a) => !liveHostIds.has(a.id.slice(0, a.id.lastIndexOf(":"))))
      .map((a) => a.id),
  );
  deleteIds(
    agentCaps,
    agentCaps.toArray.filter((a) => !liveAgents.has(a.id)).map((a) => a.id),
  );

  // syncLog is deliberately KEPT — it's a historical record of past syncs
  // (rendered from its own rows, never joined against live repos), so entries
  // must survive repos coming and going. It's bounded by SYNC_LOG_CAP and
  // cleared only by a full workspace reset.
  // ignoredRepos$ is deliberately KEPT — hiding a folder is a preference that
  // should survive removing and re-pairing its device.
}

// --- device removal ---

/** Drop a device and everything that lived on it: its device/host/override rows,
 *  every thread synced from it, then the full dependent cascade. */
export function forgetDevice(id: string): void {
  if (devices.has(id)) devices.delete(id);
  if (hosts.has(id)) hosts.delete(id);
  if (deviceOverrides.has(id)) deviceOverrides.delete(id);
  deleteIds(
    threads,
    threads.toArray.filter((s) => s.hostId === id).map((s) => s.id),
  );
  cascadeCleanup();
}

/**
 * Fold everything synced under `fromId` onto `toId` — the same machine, found
 * twice.
 *
 * Devices used to be identified by the address they were paired at, so one Mac
 * reached over the LAN, over loopback and through the emulator's 10.0.2.2 alias
 * became three devices. The bridge now reports a stable id for itself, and when
 * a sync reveals that an existing device is really one we already have, its rows
 * move here rather than being deleted: threads are re-pointed at the surviving
 * host (their ids are the agent's own, identical from either address, so this is
 * a field update and never collides), and a device override is carried across
 * only if the survivor hasn't got one — an explicit choice on the device you
 * kept outranks one made against a duplicate.
 */
export function mergeDevice(fromId: string, toId: string): void {
  if (fromId === toId) return;
  const moved = threads.toArray
    .filter((s) => s.hostId === fromId)
    .map((s) => ({ ...s, hostId: toId }));
  if (moved.length) upsertRows(threads, moved);

  const override = deviceOverrides.get(fromId);
  if (override && !deviceOverrides.has(toId)) {
    upsertRows(deviceOverrides, [{ ...override, id: toId }]);
  }
  if (deviceOverrides.has(fromId)) deviceOverrides.delete(fromId);
  if (devices.has(fromId)) devices.delete(fromId);
  if (hosts.has(fromId)) hosts.delete(fromId);

  if (connection$.activeHostId.get() === fromId) connection$.activeHostId.set(toId);
  cascadeCleanup();
}

/** Reconcile every store against the real paired-device list. A device whose
 *  bridge predates stable ids still gets a URL-derived id, so re-pairing that
 *  machine under a new address mints a new device id and orphans the threads
 *  synced under the old one — with no device row left to delete them, they'd
 *  haunt "Jump back in". Sweep anything whose
 *  host is no longer paired, then cascade. Connection state follows the paired
 *  set too, so every removal path (not just Settings) leaves the UI honest:
 *  clear a now-unpaired active host, and go disconnected when nothing's paired. */
export function reconcileDevices(validIds: string[]): void {
  const valid = new Set(validIds);
  deleteIds(
    devices,
    keyList(devices).filter((id) => !valid.has(id)),
  );
  deleteIds(
    hosts,
    keyList(hosts).filter((id) => !valid.has(id)),
  );
  deleteIds(
    deviceOverrides,
    keyList(deviceOverrides).filter((id) => !valid.has(id)),
  );
  deleteIds(
    threads,
    threads.toArray.filter((s) => !valid.has(s.hostId)).map((s) => s.id),
  );
  cascadeCleanup();

  if (valid.size === 0) connection$.status.set("disconnected");
  const active = connection$.activeHostId.get();
  if (active && !valid.has(active)) connection$.activeHostId.set(null);
}

// --- live-sync writers (called from bridge.ts) ---

export interface WorkspaceData {
  repos: Record<string, Repository>;
  sessions: Record<string, Session>;
  devices?: Record<string, Device>;
}

/** Progressive (streaming) upsert used per page — adds/updates rows without
 *  deleting anything, so the list fills in without blanking. */
export function mergeWorkspace(data: WorkspaceData): void {
  upsertRows(projects, Object.values(data.repos));
  upsertRows(threads, Object.values(data.sessions));
  if (data.devices) upsertRows(devices, Object.values(data.devices));
}

/** Authoritative sync: make projects/threads/devices match the incoming set
 *  (upsert present, delete absent), record the sync-history diff, and cascade
 *  satellites for anything removed.
 *
 *  Authority is PER HOST: only hosts in `syncedHostIds` completed this sync, so
 *  only their threads may be deleted for being absent. Any other host (offline,
 *  mid-reconnect, failed fetch) keeps its last-known threads verbatim — a failed
 *  read is not evidence the work is gone, and deleting here would cascade away
 *  recents ("Jump back in"), markers, favorites and cached messages that can't
 *  be rebuilt from the host. Omitting syncedHostIds means every host synced. */
export function syncWorkspace(
  data: WorkspaceData,
  opts?: { syncedHostIds?: readonly string[] },
): void {
  const prev = new Map(threads.toArray.map((s) => [s.id, s] as const));
  const synced = opts?.syncedHostIds ? new Set(opts.syncedHostIds) : null;
  // Local optimistic drafts (`new_*`, awaiting their first turn's real id) are
  // OUR records, not the host's — a host sync can't vouch for an id it has never
  // seen, and deleting one mid-turn blanks the open session ("Session not
  // found") until rekey. Age-capped so a turn that died pre-rekey can't leave a
  // "Queued" ghost forever.
  const now = Date.now();
  const isLocalDraft = (s: { id: string; createdAt?: string | null }) =>
    s.id.startsWith("new_") && now - Date.parse(s.createdAt ?? "") < 60 * 60 * 1000;
  const preserved = threads.toArray.filter(
    (s) => (synced ? !synced.has(s.hostId) : false) || isLocalDraft(s),
  );
  const preservedRepoIds = new Set(preserved.map((s) => s.repoId));
  // Preserved rows first: when a host half-streamed before failing, the fresher
  // incoming row for the same id wins the upsert.
  const nextSessions = [...preserved, ...Object.values(data.sessions)];
  const nextRepos = [
    ...projects.toArray.filter((r) => preservedRepoIds.has(r.id) && !data.repos[r.id]),
    ...Object.values(data.repos),
  ];
  replaceAll(projects, nextRepos);
  replaceAll(threads, nextSessions);
  if (data.devices) replaceAll(devices, Object.values(data.devices));
  recordSync(prev, nextSessions, data.repos, new Date().toISOString());
  cascadeCleanup();
}

/** Upsert host records reported during sync. */
export function upsertHosts(rows: Host[]): void {
  upsertRows(hosts, rows);
}

/** Wipe everything (used when leaving demo / hard reset). */
export function clearWorkspace(): void {
  [
    devices,
    hosts,
    projects,
    threads,
    recents,
    syncLog,
    favorites,
    threadModels,
    deviceOverrides,
    markers,
    agentCaps,
    agentModels,
    messages,
  ].forEach(clearCollection);
}
