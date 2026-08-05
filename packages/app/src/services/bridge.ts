/**
 * Live data via the Pounce Bridge (apps/bridge/server.mjs running on the host).
 *
 * The bridge reads coding-agent sessions from the host's disk and exposes them
 * over HTTP; here we fetch that data and map the threads onto the app's
 * Project/Conversation model. On the LAN we hit the bridge's address directly;
 * off-LAN, bridgeBase() swaps in a loopback proxy that carries the same HTTP
 * over an iroh p2p tunnel (github.com/n0-computer/iroh) to the paired machine.
 */
import * as SecureStore from "./secureStore";
import type {
  Agent,
  AgentCapabilities,
  Device,
  DoctorReport,
  Host,
  PairPayload,
  PermissionMode,
  PounceConfig,
  Repository,
  RunImage,
  Session,
  TimelineEvent,
} from "@pounce/shared";
import { parseUserMessage } from "@pounce/transcript";
import {
  cachedModels,
  connection$,
  firstUserMessages,
  forgetDevice,
  mergeWorkspace,
  reconcileDevices,
  setAgentCaps,
  setCachedModels,
  syncWorkspace,
  upsertHosts,
} from "../state/stores";
import { type ActivityPage, mergeActivity } from "./activity";
import { clearNotify, notifyOnce } from "./notify";
import { alertAwaitingSessions } from "./promptAlerts";
import { streamTurn } from "./streamTurn";

const BRIDGE_KEY = "pounce.bridge";

export interface BridgeConfig {
  readonly url: string; // e.g. http://192.168.1.6:8099
  readonly token: string;
}

interface BridgeThread {
  id: string;
  agent: Agent["id"];
  cwd: string | null;
  name: string | null;
  preview: string | null;
  createdAt: string | null;
  gitBranch: string | null;
  modelProvider: string | null;
  permissionMode: string | null;
  repo: string;
  worktree: string | null;
  isWorktree: boolean;
  isLive: boolean;
  activity?: string | null;
  lastActivityAt?: string | null;
}

interface BridgeAgent {
  id: Agent["id"];
  displayName: string;
  available: boolean;
  capabilities?: AgentCapabilities | null;
}

/** A configured device (one machine's bridge). */
export interface DeviceConfig extends BridgeConfig {
  readonly id: string;
  readonly name: string;
}

const DEVICES_KEY = "pounce.devices";

function deviceId(url: string): string {
  return `dev:${url.replace(/[^a-z0-9]/gi, "")}`;
}
function nameFromUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "device";
  }
}

export async function listDeviceConfigs(): Promise<DeviceConfig[]> {
  const raw = await SecureStore.getItemAsync(DEVICES_KEY);
  if (raw) return JSON.parse(raw) as DeviceConfig[];
  // migrate legacy single-bridge config
  const old = await SecureStore.getItemAsync(BRIDGE_KEY);
  if (old) {
    const c = JSON.parse(old) as BridgeConfig;
    return [{ id: deviceId(c.url), name: nameFromUrl(c.url), url: c.url, token: c.token }];
  }
  return [];
}
async function writeDeviceConfigs(list: DeviceConfig[]): Promise<void> {
  await SecureStore.setItemAsync(DEVICES_KEY, JSON.stringify(list));
}
export async function addDeviceConfig(url: string, token: string): Promise<DeviceConfig> {
  url = url.replace(/\/$/, "");
  const list = await listDeviceConfigs();
  const dev: DeviceConfig = { id: deviceId(url), name: nameFromUrl(url), url, token };
  const next = [...list.filter((d) => d.id !== dev.id), dev];
  await writeDeviceConfigs(next);
  return dev;
}
export async function removeDeviceConfig(id: string): Promise<void> {
  const list = await listDeviceConfigs();
  await writeDeviceConfigs(list.filter((d) => d.id !== id));
}
async function deviceForHost(hostId: string): Promise<DeviceConfig | null> {
  return (await listDeviceConfigs()).find((d) => d.id === hostId) ?? null;
}

// --- off-LAN fallback via the in-app Iroh tunnel ------------------------------
// When the LAN address is unreachable (gym, cellular), the app starts a local
// loopback proxy that carries HTTP over Iroh QUIC to the paired Mac's
// pounce-tunnel and swaps the base URL to it. Everything downstream — fetch,
// SSE, turn streaming — is transport-agnostic once the base is resolved.

// Same key runtime.ts uses for savePairing/loadPairing (duplicated here rather
// than imported — runtime.ts imports this module, so importing back would cycle).
const PAIRING_KEY = "pounce.pairing";
const LEGACY_PAIRING_KEY = "litter.pairing"; // pre-Pounce-rename key

const effectiveBase = new Map<string, { base: string; until: number }>(); // cfg.url -> resolution

async function probeHealth(base: string, timeoutMs: number): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/health`, { signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** The base URL requests should actually use for `cfg`: the LAN address when
 *  reachable, else the Iroh loopback proxy when a pairing is saved and the
 *  native tunnel is in this build. Cached briefly so every request doesn't
 *  re-probe; a failed LAN probe re-checks sooner than a healthy one. */
export async function bridgeBase(cfg: BridgeConfig): Promise<string> {
  const hit = effectiveBase.get(cfg.url);
  if (hit && Date.now() < hit.until) return hit.base;
  if (await probeHealth(cfg.url, 2500)) {
    effectiveBase.set(cfg.url, { base: cfg.url, until: Date.now() + 30_000 });
    return cfg.url;
  }
  try {
    const raw =
      (await SecureStore.getItemAsync(PAIRING_KEY)) ??
      (await SecureStore.getItemAsync(LEGACY_PAIRING_KEY));
    const pairing = raw ? (JSON.parse(raw) as PairPayload) : null;
    if (pairing?.nodeId) {
      const { tunnelAvailable, startTunnel } = await import("./tunnel");
      if (tunnelAvailable()) {
        const port = await startTunnel(pairing.nodeId, pairing.relay ?? null, cfg.token);
        const base = `http://127.0.0.1:${port}`;
        // Confirm end-to-end (QUIC dial happens on this first request).
        if (await probeHealth(base, 20_000)) {
          effectiveBase.set(cfg.url, { base, until: Date.now() + 60_000 });
          return base;
        }
      }
    }
  } catch {
    // fall through to the LAN URL — callers surface their own errors
  }
  effectiveBase.set(cfg.url, { base: cfg.url, until: Date.now() + 10_000 });
  return cfg.url;
}

// Back-compat single-config helpers (used by older call sites / Settings).
export async function saveBridgeConfig(cfg: BridgeConfig): Promise<void> {
  await SecureStore.setItemAsync(BRIDGE_KEY, JSON.stringify(cfg));
  await addDeviceConfig(cfg.url, cfg.token);
}
export async function loadBridgeConfig(): Promise<BridgeConfig | null> {
  const devs = await listDeviceConfigs();
  return devs[0] ?? null;
}
export async function clearBridgeConfig(): Promise<void> {
  await SecureStore.deleteItemAsync(BRIDGE_KEY);
  await SecureStore.deleteItemAsync(DEVICES_KEY);
}

async function get<T>(cfg: BridgeConfig, path: string, timeoutMs = 90_000): Promise<T> {
  // Bare fetch never times out, so an unreachable host (wrong IP, computer asleep)
  // hangs forever — the pairing/sync spinner then sticks with no error. Abort after
  // `timeoutMs` so callers get a rejection instead. Default is generous for the
  // cold thread-list sync; callers that must fail fast (health check) pass less.
  const base = await bridgeBase(cfg);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}${path}`, {
      headers: { authorization: `Bearer ${cfg.token}` },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`bridge ${path} -> ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Friendly repo display name from the bridge's repo key.
 *
 * The key is a real folder name now. `ws:<id>` keys used to arrive here for any
 * worktree the bridge couldn't trace back to its project, and every one of them
 * rendered as "Workspace" — so N unrelated worktrees showed up as N identical,
 * duplicate-looking Spaces. The bridge resolves worktrees against git's own
 * records instead (see resolveWorktreeOwners), and names whatever it can't place
 * after its directory, so there is no anonymous bucket left to translate. Old
 * `ws:` keys can still arrive from a bridge that hasn't been updated yet; show
 * the id rather than collapsing them all onto one name.
 */
function repoName(key: string): string {
  return key.startsWith("ws:") ? `Workspace ${key.slice(3)}` : key;
}

/**
 * Clean prose from a raw user message. The daemon's `preview` (and a persisted
 * first message) is the raw first user turn, which for slash commands carries
 * Claude's wrapper tags (<local-command-caveat>, <command-message>…). Run it
 * through the transcript parser so we get clean prose. For a slash command we
 * take only its ARGUMENTS ("/goal ship the beta" → "ship the beta") — a bare
 * command ("/clear") makes a poor title, so it yields nothing and the caller
 * falls through to the next signal.
 */
function messageProse(raw: string, agent: string): string {
  const p = parseUserMessage(raw.trim(), agent);
  return (p.text || p.command?.args || p.output?.text || "").trim();
}

/**
 * A readable thread title, best-effort from data we already have (no per-thread
 * fetch, so sync stays fast). In order of preference:
 *   1. the daemon's first-message preview;
 *   2. the first user message we've persisted locally (threads you've opened);
 *   3. a plain "Untitled session" — never a bare "Untitled task".
 */
function threadTitle(t: BridgeThread, firstMessage: string | null): string {
  const prose =
    messageProse(t.name || t.preview || "", t.agent) ||
    (firstMessage ? messageProse(firstMessage, t.agent) : "");
  return prose.slice(0, 100) || "Untitled session";
}

interface BridgeStatus {
  device?: string;
  nodeId?: string;
  version?: string;
}

/** Pull agents + threads from ALL configured devices and aggregate. */
// A connect-time sync often sees an empty daemon for one tick (cold Iroh dial),
// so only alert once the "reachable but no agents" state survives a second sync —
// a transient cold start never fires, a genuinely-down daemon does.
let daemonDownStreak = 0;
function flagDaemonHealth(daemonDown: string[]): void {
  if (daemonDown.length) {
    daemonDownStreak++;
    if (daemonDownStreak >= 2) {
      void notifyOnce(
        "daemon-unreachable",
        "Coding agents unreachable",
        `Pounce reached ${daemonDown[0]} but no agents responded. Restart the Pounce Bridge (or your coding agent), then pull to refresh.`,
      );
    }
  } else {
    daemonDownStreak = 0;
    clearNotify("daemon-unreachable");
  }
}

/** Earliest-user-message-per-thread lookup, computed once per sync (never per
 *  streamed page) and threaded through so titling stays O(messages) not
 *  O(pages × messages). */
type FirstMessages = ReturnType<typeof firstUserMessages>;

/** Map accumulated per-device threads into the app's repo/session shape. Mirrors
 *  the batch mapping in syncLiveData; kept separate so streaming can rebuild the
 *  store incrementally without touching the batch path. */
function buildWorkspace(
  threadsByDevice: Record<string, { name: string; threads: BridgeThread[] }>,
  now: string,
  firstMsg: FirstMessages,
): { repos: Record<string, Repository>; sessions: Record<string, Session> } {
  const repos: Record<string, Repository> = {};
  const sessions: Record<string, Session> = {};
  for (const [devId, { name: deviceName, threads }] of Object.entries(threadsByDevice)) {
    for (const t of threads) {
      const repoId = `repo:${t.repo}`;
      const createdTs = t.createdAt ?? now;
      const updatedTs = t.lastActivityAt ?? createdTs;
      const activity = (t.activity as Session["activity"]) ?? (t.isLive ? "idle" : "completed");
      const needsAttention = activity === "failed" || activity === "awaiting_input";
      sessions[t.id] = {
        id: t.id,
        repoId,
        hostId: devId,
        host: deviceName,
        agent: t.agent,
        title: threadTitle(t, firstMsg.get(t.id)?.text ?? null),
        branch: t.gitBranch ?? (t.isWorktree ? t.worktree : null),
        worktree: t.worktree,
        cwd: t.cwd,
        isLive: t.isLive,
        activity,
        needsAttention,
        createdAt: createdTs,
        updatedAt: updatedTs,
        permissionMode: (t.permissionMode as Session["permissionMode"]) ?? null,
      };
      const r = repos[repoId];
      repos[repoId] = r
        ? {
            ...r,
            sessionCount: r.sessionCount + 1,
            liveCount: r.liveCount + (t.isLive ? 1 : 0),
            attentionCount: r.attentionCount + (needsAttention ? 1 : 0),
            lastActivityAt: updatedTs > r.lastActivityAt ? updatedTs : r.lastActivityAt,
          }
        : {
            id: repoId,
            name: repoName(t.repo),
            sessionCount: 1,
            liveCount: t.isLive ? 1 : 0,
            attentionCount: needsAttention ? 1 : 0,
            lastActivityAt: updatedTs,
          };
    }
  }
  return { repos, sessions };
}

/** Read the bridge's SSE thread stream, invoking `onBatch` per page as it lands.
 *  Uses the streamTurn seam (nitro-fetch on mobile, XHR on desktop) and parses
 *  the SSE frames here. */
async function streamThreadsFromBridge(
  cfg: BridgeConfig,
  onBatch: (threads: BridgeThread[]) => void,
): Promise<void> {
  let buf = "";
  let streamError: string | null = null;
  let finished = false;
  const base = await bridgeBase(cfg);
  await streamTurn(
    `${base}/v1/threads/stream`,
    { method: "GET", headers: { authorization: `Bearer ${cfg.token}` } },
    (chunk) => {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = frame.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        let d: { threads?: BridgeThread[]; done?: boolean; error?: string } | null = null;
        try {
          d = JSON.parse(line.slice(5).trim());
        } catch {
          continue;
        }
        if (d?.threads?.length) onBatch(d.threads);
        if (d?.error) streamError = d.error;
        if (d?.done || d?.error) finished = true;
      }
      // Terminal frame seen → tell the seam to stop reading; a fast bridge
      // closes before the reader ever reports `done`, which hung connect.
      return finished;
    },
  );
  if (streamError) throw new Error(streamError);
}

/**
 * Progressive connect-time sync: fetch each device's status/agents, then stream
 * its threads page-by-page, rebuilding the store after each batch so the list
 * fills in as pages land instead of blocking on the whole fetch.
 * Used only on connect — pull-to-refresh/periodic stay on the atomic batch path
 * to avoid a shrink-then-grow flicker over already-shown data.
 */
export async function syncLiveDataStreaming(): Promise<{
  repos: number;
  sessions: number;
  devices: number;
}> {
  const configs = await listDeviceConfigs();
  const now = new Date().toISOString();
  const firstMsg = firstUserMessages(); // scan the message store once, not per page
  const devices: Record<string, Device> = {};
  const threadsByDevice: Record<string, { name: string; threads: BridgeThread[] }> = {};
  const daemonDown: string[] = [];
  // Hosts whose sync ran to completion — only their threads may be deleted by
  // the final authoritative sync. A host that errored (offline, cold tunnel,
  // half-streamed) keeps its last-known state.
  const syncedHostIds: string[] = [];

  // While streaming, MERGE fresh threads over whatever's already shown (persisted
  // last-known state) instead of replacing — so the list appears instantly and
  // fills in live, never blanking or shrinking. The authoritative replace (which
  // drops now-gone sessions) happens once at the end.
  const merge = () => {
    const { repos, sessions } = buildWorkspace(threadsByDevice, now, firstMsg);
    mergeWorkspace({ repos, sessions, devices });
  };

  await Promise.all(
    configs.map(async (cfg) => {
      threadsByDevice[cfg.id] = { name: cfg.name, threads: [] };
      let online = true;
      let deviceName = cfg.name;
      let agentsReported = 0;
      let agentsAvail: string[] = [];
      try {
        const [{ status }, { agents }] = await Promise.all([
          get<{ status: BridgeStatus }>(cfg, "/v1/status"),
          get<{ agents: BridgeAgent[] }>(cfg, "/v1/agents"),
        ]);
        deviceName = status?.device || cfg.name;
        agentsReported = (agents || []).length;
        agentsAvail = (agents || []).filter((a) => a.available).map((a) => a.id);
        for (const a of agents || []) if (a.capabilities) setAgentCaps(a.id, a.capabilities);
        threadsByDevice[cfg.id].name = deviceName;
        devices[cfg.id] = {
          id: cfg.id,
          name: deviceName,
          url: cfg.url,
          online,
          agents: agentsAvail as Device["agents"],
          sessionCount: 0,
          lastSyncAt: now,
        };
        upsertHosts([
          { id: cfg.id, nodeId: cfg.id, name: deviceName, online, lastSeenAt: now } satisfies Host,
        ]);
        // Stream threads; rebuild after each page so the list grows live.
        await streamThreadsFromBridge(cfg, (batch) => {
          threadsByDevice[cfg.id].threads.push(...batch);
          devices[cfg.id] = {
            ...devices[cfg.id],
            sessionCount: threadsByDevice[cfg.id].threads.length,
          };
          merge();
        });
        syncedHostIds.push(cfg.id);
      } catch {
        online = false;
        devices[cfg.id] = {
          id: cfg.id,
          name: deviceName,
          url: cfg.url,
          online: false,
          agents: agentsAvail as Device["agents"],
          sessionCount: threadsByDevice[cfg.id].threads.length,
          lastSyncAt: now,
        };
      }
      if (online && agentsReported === 0) daemonDown.push(deviceName);
    }),
  );

  const { repos, sessions } = buildWorkspace(threadsByDevice, now, firstMsg);
  syncWorkspace({ repos, sessions, devices }, { syncedHostIds });
  flagDaemonHealth(daemonDown);
  alertAwaitingSessions(sessions);
  const warmed = new Set<string>();
  for (const s of Object.values(sessions)) {
    const key = `${s.hostId}:${s.agent}`;
    if (warmed.has(key)) continue;
    warmed.add(key);
    void warmModels(s.hostId, s.agent);
  }
  return {
    repos: Object.keys(repos).length,
    sessions: Object.keys(sessions).length,
    devices: Object.keys(devices).length,
  };
}

export async function syncLiveData(opts?: {
  fresh?: boolean;
}): Promise<{ repos: number; sessions: number; devices: number }> {
  // On an explicit pull-to-refresh we bypass the bridge's 20s cache so a
  // just-opened session shows up immediately.
  const q = opts?.fresh ? "?fresh=1" : "";
  const configs = await listDeviceConfigs();
  const repos: Record<string, Repository> = {};
  const sessions: Record<string, Session> = {};
  const devices: Record<string, Device> = {};
  const now = new Date().toISOString();
  const firstMsg = firstUserMessages(); // local first-message titles, once per sync
  // Devices whose bridge answered but whose agent daemon reported nothing — the
  // "reachable but no agents" state the user has to fix (restart the bridge/agent).
  const daemonDown: string[] = [];
  // Hosts whose fetch succeeded — only they are authoritative below (see
  // syncWorkspace): an unreachable host keeps its last-known threads instead of
  // having them (and the user's recents/markers/messages) swept away.
  const syncedHostIds: string[] = [];

  await Promise.all(
    configs.map(async (cfg) => {
      let deviceName = cfg.name;
      let online = true;
      let agentsAvail: string[] = [];
      let agentsReported = 0;
      let threads: BridgeThread[] = [];
      try {
        const [{ status }, { agents }, t] = await Promise.all([
          get<{ status: BridgeStatus }>(cfg, "/v1/status"),
          get<{ agents: BridgeAgent[] }>(cfg, `/v1/agents${q}`),
          get<{ threads: BridgeThread[] }>(cfg, `/v1/threads${q}`),
        ]);
        deviceName = status?.device || cfg.name;
        agentsReported = (agents || []).length;
        agentsAvail = (agents || []).filter((a) => a.available).map((a) => a.id);
        // Record per-agent capabilities so the composer can gate its controls.
        for (const a of agents || []) {
          if (a.capabilities) setAgentCaps(a.id, a.capabilities);
        }
        threads = t.threads;
        syncedHostIds.push(cfg.id);
      } catch {
        online = false;
      }
      // Bridge reachable (status OK) but the daemon handed back zero agents.
      if (online && agentsReported === 0) daemonDown.push(deviceName);

      devices[cfg.id] = {
        id: cfg.id,
        name: deviceName,
        url: cfg.url,
        online,
        agents: agentsAvail as Device["agents"],
        sessionCount: threads.length,
        lastSyncAt: now,
      };
      upsertHosts([
        {
          id: cfg.id,
          nodeId: cfg.id,
          name: deviceName,
          online,
          lastSeenAt: now,
        } satisfies Host,
      ]);

      for (const t of threads) {
        const repoId = `repo:${t.repo}`;
        const createdTs = t.createdAt ?? now;
        const updatedTs = t.lastActivityAt ?? createdTs;
        // Real state derived host-side; fall back to live/archived heuristic.
        const activity = (t.activity as Session["activity"]) ?? (t.isLive ? "idle" : "completed");
        const needsAttention = activity === "failed" || activity === "awaiting_input";
        sessions[t.id] = {
          id: t.id,
          repoId,
          hostId: cfg.id,
          host: deviceName,
          agent: t.agent,
          title: threadTitle(t, firstMsg.get(t.id)?.text ?? null),
          branch: t.gitBranch ?? (t.isWorktree ? t.worktree : null),
          worktree: t.worktree,
          cwd: t.cwd,
          isLive: t.isLive,
          activity,
          needsAttention,
          createdAt: createdTs,
          updatedAt: updatedTs,
          permissionMode: (t.permissionMode as Session["permissionMode"]) ?? null,
        };
        const r = repos[repoId];
        repos[repoId] = r
          ? {
              ...r,
              sessionCount: r.sessionCount + 1,
              liveCount: r.liveCount + (t.isLive ? 1 : 0),
              attentionCount: r.attentionCount + (needsAttention ? 1 : 0),
              lastActivityAt: updatedTs > r.lastActivityAt ? updatedTs : r.lastActivityAt,
            }
          : {
              id: repoId,
              name: repoName(t.repo),
              sessionCount: 1,
              liveCount: t.isLive ? 1 : 0,
              attentionCount: needsAttention ? 1 : 0,
              lastActivityAt: updatedTs,
            };
      }
    }),
  );

  // syncWorkspace records the per-repo diff into Sync history before swapping.
  syncWorkspace({ repos, sessions, devices }, { syncedHostIds });
  flagDaemonHealth(daemonDown);
  alertAwaitingSessions(sessions);
  // Warm the model catalog for each device+agent in the background, so opening
  // the model picker later is instant. Fire-and-forget; throttled per key.
  const warmed = new Set<string>();
  for (const s of Object.values(sessions)) {
    const key = `${s.hostId}:${s.agent}`;
    if (warmed.has(key)) continue;
    warmed.add(key);
    void warmModels(s.hostId, s.agent);
  }
  return {
    repos: Object.keys(repos).length,
    sessions: Object.keys(sessions).length,
    devices: Object.keys(devices).length,
  };
}

/** One full-text hit from a device's history index. threadId matches the
 *  Session id synced from that device, so hits join to the local store. */
export interface MessageSearchHit {
  hostId: string;
  agent: string;
  threadId: string;
  snippet: string;
  title: string | null;
  timestamp: string | null;
  matches: number;
}

/**
 * Full-text search over message bodies across every paired device. Devices
 * that are unreachable or don't have search installed (501) just contribute
 * nothing — the section renders from whoever answered.
 *
 * Scoping: `thread` (with `hostId` + `agent`) searches WITHIN one session and
 * returns per-message hits; `workspace` narrows to a repo/cwd substring;
 * `hostId` alone limits the fan-out to one device.
 */
export async function searchMessages(
  q: string,
  opts?: { limit?: number; thread?: string; agent?: string; workspace?: string; hostId?: string },
): Promise<MessageSearchHit[]> {
  const all = await listDeviceConfigs();
  const devices = opts?.hostId ? all.filter((d) => d.id === opts.hostId) : all;
  const params = new URLSearchParams({ q, limit: String(opts?.limit ?? 20) });
  if (opts?.thread) params.set("thread", opts.thread);
  if (opts?.agent) params.set("agent", opts.agent);
  if (opts?.workspace) params.set("workspace", opts.workspace);
  const pages = await Promise.all(
    devices.map(async (cfg) => {
      try {
        const { results } = await get<{ results: Omit<MessageSearchHit, "hostId">[] }>(
          cfg,
          `/v1/search?${params.toString()}`,
          20_000,
        );
        return results.map((r) => ({ ...r, hostId: cfg.id }));
      } catch {
        return [];
      }
    }),
  );
  const hits = pages.flat();
  // In-thread hits read top-to-bottom (chronological); cross-thread results
  // stay newest-first.
  return opts?.thread
    ? hits.sort(
        (a, b) => (Date.parse(a.timestamp ?? "") || 0) - (Date.parse(b.timestamp ?? "") || 0),
      )
    : hits.sort(
        (a, b) => (Date.parse(b.timestamp ?? "") || 0) - (Date.parse(a.timestamp ?? "") || 0),
      );
}

/** Fetch a session's real message history from its device. */
export async function fetchMessages(
  hostId: string,
  agent: string,
  threadId: string,
  opts?: { limit?: number; fresh?: boolean },
): Promise<TimelineEvent[]> {
  const cfg = await deviceForHost(hostId);
  if (!cfg) return [];
  const limit = opts?.limit ? `&limit=${opts.limit}` : "";
  // fresh=1 makes the host re-parse the transcript instead of serving its LRU —
  // used right after a turn, when the cache can predate the turn's writes.
  const fresh = opts?.fresh ? "&fresh=1" : "";
  const { events } = await get<{ events: TimelineEvent[] }>(
    cfg,
    `/v1/messages?agent=${encodeURIComponent(agent)}&thread=${encodeURIComponent(threadId)}${limit}${fresh}`,
  );
  // Resolve image refs to loadable, token-authed bridge URLs. The client only
  // hits these when a message scrolls into view (lazy <Image>), so the events
  // payload stays tiny even for threads full of screenshots.
  const base = await bridgeBase(cfg);
  const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp|heic|svg)$/i;
  return events.map((e) => {
    if (e.type === "user_message" && e.images?.length) {
      const images = e.images.map((img) =>
        img.ref && !img.uri
          ? {
              ...img,
              uri: `${base}/v1/image?agent=${encodeURIComponent(agent)}&thread=${encodeURIComponent(
                threadId,
              )}&ref=${encodeURIComponent(img.ref)}&token=${encodeURIComponent(cfg.token)}`,
            }
          : img,
      );
      return { ...e, images };
    }
    // A Read of an image file → a token-authed bridge URL so the card previews
    // it (lazy <Image>, so the payload stays small). Read's path is absolute.
    if (e.type === "tool_call" && e.call.name === "Read") {
      const fp = (e.call.input as { file_path?: string } | null | undefined)?.file_path;
      if (typeof fp === "string" && IMG_EXT.test(fp)) {
        return {
          ...e,
          call: {
            ...e.call,
            previewUri: `${base}/v1/file?path=${encodeURIComponent(fp)}&token=${encodeURIComponent(cfg.token)}`,
          },
        };
      }
    }
    return e;
  });
}

/**
 * Per-thread usage, read from the host's own agent records.
 *
 * Tokens are always the agent's own counts. For `cost`, check `costSource`
 * before showing the number: OpenCode reports real dollars for all history,
 * Claude only for turns Pounce drove (`costComplete` false when it covers part
 * of a thread), and Codex never — it bills against a plan and reports
 * `rateLimit` consumption instead. Where no agent reports one, the bridge falls
 * back to ccusage's list-price ESTIMATE, which must be labelled as such; a
 * missing cost still means "not knowable", never "zero".
 */
export interface ThreadUsage {
  available: boolean;
  model?: string | null;
  models?: string[];
  tokens?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
    reasoning?: number;
    total: number;
  };
  cost?: number | null;
  costComplete?: boolean;
  /**
   * Where the dollars came from, and they are not interchangeable:
   *   "agent"       the CLI reported it — a real, billed figure
   *   "ccusage-est" tokens priced at public list rates; show it as approximate
   *   null          no cost at all
   */
  costSource?: "agent" | "ccusage-est" | null;
  messages?: number;
  /** Context window of the model that ran, when the agent states it. */
  contextWindow?: number | null;
  /**
   * Size of the most recent request — how full the window is right now. This is
   * NOT `tokens.total`, which sums every turn ever taken; a long thread can run
   * to tens of millions cumulatively while each request still fits the window.
   */
  contextUsed?: number | null;
  /** Plan-based consumption (Codex): how much of a rate-limit window is used. */
  rateLimit?: {
    usedPercent: number | null;
    windowMinutes: number | null;
    resetsAt: number | null;
    planType: string | null;
  } | null;
  reason?: string;
}

/** Fetch a thread's token/cost usage from its device. Returns null on any error
 *  (the status bar just hides). */
export async function fetchUsage(
  hostId: string,
  agent: string,
  threadId: string,
  cwd: string | null,
): Promise<ThreadUsage | null> {
  const cfg = await deviceForHost(hostId);
  if (!cfg) return null;
  try {
    const { usage } = await get<{ usage: ThreadUsage }>(
      cfg,
      `/v1/usage?agent=${encodeURIComponent(agent)}&thread=${encodeURIComponent(threadId)}${
        cwd ? `&cwd=${encodeURIComponent(cwd)}` : ""
      }`,
    );
    return usage;
  } catch {
    return null;
  }
}

/**
 * Daily activity across EVERY paired device, merged into one series — the
 * dashboard is about the user's work, not one machine's. Same fan-out shape as
 * searchMessages: a device that's unreachable (or too old to have the endpoint)
 * contributes nothing rather than failing the whole view.
 *
 * Merging (day sums, worst-case coverage) lives in services/activity.ts so it
 * stays unit-testable.
 */
export async function fetchActivity(days = 365, opts?: { fresh?: boolean }): Promise<ActivityPage> {
  const devices = await listDeviceConfigs();
  const qs = `days=${days}${opts?.fresh ? "&fresh=1" : ""}`;
  const pages = await Promise.all(
    devices.map(async (cfg) => {
      try {
        // Generous timeout: the host's first call of the day parses transcripts
        // it hasn't summarized yet (cold cache), which can take seconds.
        return await get<ActivityPage>(cfg, `/v1/activity?${qs}`, 120_000);
      } catch {
        return null;
      }
    }),
  );
  // Every host failed → we know NOTHING, which is not the same as knowing there
  // was no activity. Swallowing this returned an empty-but-valid series, and
  // the dashboard dutifully reported "No activity yet" to someone with months
  // of history — the cold-cache first call had simply timed out while the host
  // parsed its transcripts. Throwing lets the caller show a spinner, retry, and
  // say "couldn't read" instead of asserting a zero.
  //
  // A PARTIAL failure still merges: one unreachable machine shouldn't blank the
  // others, and `coverage` already records what couldn't be accounted for.
  if (devices.length > 0 && pages.every((p) => p === null)) {
    throw new Error("Couldn't read activity from any paired machine.");
  }
  return mergeActivity(pages);
}

/**
 * One SPACE's daily activity — one repository on one machine.
 *
 * Deliberately not a fan-out like `fetchActivity`: a Space is scoped to a
 * single host by definition (the same repo on two machines is two Spaces with
 * their own worktrees and their own agents), so merging hosts here would be
 * answering a different question.
 *
 * The host returns only figures it can attribute to this repo, which means
 * agent-reported dollars and nothing else — org billing totals and list-price
 * estimates are whole-machine numbers and can't be split per project. Days
 * therefore carry `cost: null` more often here than on the dashboard, and the
 * UI must keep rendering that as "not knowable" rather than $0.
 */
export async function fetchSpaceActivity(
  hostId: string,
  repoKey: string,
  days = 90,
  opts?: { fresh?: boolean },
): Promise<ActivityPage | null> {
  const cfg = await deviceForHost(hostId);
  if (!cfg) return null;
  const qs = `days=${days}&repo=${encodeURIComponent(repoKey)}${opts?.fresh ? "&fresh=1" : ""}`;
  try {
    return await get<ActivityPage>(cfg, `/v1/activity?${qs}`, 120_000);
  } catch {
    return null;
  }
}

/** One rolling rate-limit window as an agent reports it. */
export interface QuotaWindow {
  label: string;
  usedPercent: number;
  windowMinutes: number | null;
  resetsAt: string | null;
}

/**
 * Rolling-window usage MEASURED from the agent's own transcripts, for agents
 * that publish no meter. Deliberately carries no percentage: the window's size
 * isn't knowable locally, and inferring a ceiling from your busiest past window
 * turns a guess into a gauge (see agents/blocks.mjs).
 */
export interface UsageBlocks {
  agent: string;
  windowHours: number;
  current: {
    startedAt: string;
    resetsAt: string;
    tokens: number;
    messages: number;
    tokensPerMin: number;
  } | null;
  /** Busiest window within `scannedDays` — context, NOT a limit, and NOT an
   *  all-time high: the bridge reads only each transcript's tail. */
  peak: { tokens: number; startedAt: string };
  weeklyTokens: number;
  scannedDays: number;
}

export interface AgentQuota {
  hostId: string;
  agent: string;
  planType: string | null;
  /** Why there are no `windows`, for agents that name a plan but publish no
   *  meter locally (Claude, Cursor, opencode). Absent when a meter exists. */
  note?: string | null;
  /** When the agent last reported this — it can be days stale. */
  observedAt: string | null;
  windows: QuotaWindow[];
  /** Our own measurement, kept out of `windows` so a derived figure can never
   *  be mistaken for one the agent reported. */
  blocks?: UsageBlocks | null;
}

/**
 * Plan quota across every paired device. On a subscription this is the number
 * that actually means something — dollars don't exist to report. Agents with
 * nothing to say are simply absent.
 */
export async function fetchQuota(): Promise<AgentQuota[]> {
  const devices = await listDeviceConfigs();
  const pages = await Promise.all(
    devices.map(async (cfg) => {
      try {
        const { quota } = await get<{
          quota: Record<string, Omit<AgentQuota, "hostId" | "agent">>;
        }>(cfg, "/v1/quota", 15_000);
        return Object.entries(quota ?? {}).map(([agent, q]) => ({ ...q, agent, hostId: cfg.id }));
      } catch {
        return [];
      }
    }),
  );
  // Most-consumed window first: the one closest to biting is the one to show.
  return pages
    .flat()
    .sort((a, b) => (b.windows[0]?.usedPercent ?? 0) - (a.windows[0]?.usedPercent ?? 0));
}

/** One selectable model for an agent, from the daemon's model/list. */
export interface ModelInfo {
  id: string;
  name: string;
  description?: string | null;
  isDefault?: boolean;
  deprecated?: boolean;
}

/** Fetch models and cache them into `agentModels$`, so the picker opens
 *  instantly. Throttled per device+agent and skipped while a recent cache
 *  exists — safe to call on every sync and on sheet-open (stale-while-revalidate).
 *  Never overwrites a good cache with an empty (error) result. */
const modelWarmAt = new Map<string, number>();
const MODEL_WARM_TTL = 10 * 60_000;
export async function warmModels(hostId: string, agent: string): Promise<void> {
  const key = `${hostId}:${agent}`;
  const last = modelWarmAt.get(key) ?? 0;
  if (cachedModels(hostId, agent) && Date.now() - last < MODEL_WARM_TTL) return;
  modelWarmAt.set(key, Date.now());
  const models = await fetchModels(hostId, agent);
  if (models.length) setCachedModels(hostId, agent, models);
  else modelWarmAt.delete(key); // let a failed warm retry sooner
}

/** Available models for an agent on a device (daemon model/list). [] on error. */
export async function fetchModels(hostId: string, agent: string): Promise<ModelInfo[]> {
  const cfg = await deviceForHost(hostId);
  if (!cfg) return [];
  try {
    const { models } = await get<{ models: ModelInfo[] }>(
      cfg,
      `/v1/models?agent=${encodeURIComponent(agent)}`,
    );
    return models ?? [];
  } catch {
    return [];
  }
}

/** Run a one-shot shell command in a session's cwd on its host. */
export async function runExec(
  hostId: string,
  cwd: string | null,
  command: string,
): Promise<{ code: number; output: string }> {
  const cfg = await deviceForHost(hostId);
  if (!cfg) return { code: -1, output: "device not found" };
  try {
    const res = await fetch(`${await bridgeBase(cfg)}/v1/exec`, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
      body: JSON.stringify({ cwd, command }),
    });
    return (await res.json()) as { code: number; output: string };
  } catch (e) {
    return { code: -1, output: String(e) };
  }
}

export interface GitFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
}
export interface GitChanges {
  branch: string | null;
  files: GitFile[];
  diff: string;
  /** Commits ahead/behind upstream; null when there is no upstream (or an old bridge). */
  ahead?: number | null;
  behind?: number | null;
  /** Count of unmerged (conflicted) files. */
  conflicts?: number;
}

/** Summarised CI status of the branch's open PR (via gh on the host). */
export interface GitChecks {
  checks: "passing" | "failing" | "pending" | null;
  failed: number;
  total: number;
}

/** Summed additions/deletions across changed files. */
export function diffTotals(files: GitFile[]): { add: number; del: number } {
  return files.reduce((t, f) => ({ add: t.add + f.additions, del: t.del + f.deletions }), {
    add: 0,
    del: 0,
  });
}

/** Uncommitted changes in a session's worktree. */
export async function fetchGitChanges(hostId: string, cwd: string): Promise<GitChanges> {
  const cfg = await deviceForHost(hostId);
  if (!cfg) return { branch: null, files: [], diff: "" };
  try {
    return await get<GitChanges>(cfg, `/v1/git/changes?cwd=${encodeURIComponent(cwd)}`);
  } catch {
    return { branch: null, files: [], diff: "" };
  }
}

/** CI checks for the branch's PR. null checks = no PR, no gh, or old bridge. */
export async function fetchGitChecks(hostId: string, cwd: string): Promise<GitChecks> {
  const cfg = await deviceForHost(hostId);
  if (!cfg) return { checks: null, failed: 0, total: 0 };
  try {
    return await get<GitChecks>(cfg, `/v1/git/checks?cwd=${encodeURIComponent(cwd)}`);
  } catch {
    return { checks: null, failed: 0, total: 0 };
  }
}

/** One of a project's agent-instruction files, as the host read it. */
export interface ContextFile {
  /** Forward-slashed path relative to the project root, e.g. `.claude/CLAUDE.md`. */
  path: string;
  name: string;
  /** The file's real size on disk — larger than `content` when truncated. */
  size: number;
  mtime: string;
  content: string;
  truncated: boolean;
}

export interface ContextFiles {
  cwd: string;
  files: ContextFile[];
}

/**
 * A project's CLAUDE.md/AGENTS.md files.
 *
 * `null` means the host couldn't answer — unreachable, or a bridge too old to
 * have the route. That's different from an answer with no files (a project
 * that simply has no context yet), which the screen offers to fix, so the two
 * must not collapse into the same value.
 */
export async function fetchContextFiles(hostId: string, cwd: string): Promise<ContextFiles | null> {
  const cfg = await deviceForHost(hostId);
  if (!cfg) return null;
  try {
    return await get<ContextFiles>(cfg, `/v1/context?cwd=${encodeURIComponent(cwd)}`, 20_000);
  } catch {
    return null;
  }
}

/**
 * The outcome of saving a context file.
 *
 * `conflict` is its own case rather than an error string because it's the one
 * failure the user can act on: the file changed on the host (an agent turn
 * edited it) since we read it, and the editor has to offer reload-or-overwrite
 * instead of just reporting that something went wrong. `mtime` is what the host
 * sees now, so a reload can be checked against it.
 */
export type SaveContextResult =
  | { ok: true; file: ContextFile }
  | { ok: false; conflict: true; mtime: string | null }
  | { ok: false; conflict?: false; error: string };

/**
 * Write one of a project's context files on its host.
 *
 * `expectedMtime` is the version this client last read — pass it so a save
 * can't silently overwrite an edit made while the editor was open. Pass `null`
 * when creating a file that shouldn't exist yet, `undefined` to force.
 */
export async function saveContextFile(
  hostId: string,
  cwd: string,
  filePath: string,
  content: string,
  expectedMtime?: string | null,
): Promise<SaveContextResult> {
  const cfg = await deviceForHost(hostId);
  if (!cfg) return { ok: false, error: "This machine isn't paired any more." };
  try {
    const res = await fetch(`${await bridgeBase(cfg)}/v1/context`, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        cwd,
        path: filePath,
        content,
        // Only send the key when the caller supplied one — an absent `mtime`
        // is what tells the host "force", and JSON.stringify drops undefined.
        ...(expectedMtime === undefined ? {} : { mtime: expectedMtime }),
      }),
    });
    const body = (await res.json().catch(() => null)) as {
      file?: ContextFile;
      error?: string;
      mtime?: string | null;
    } | null;
    if (res.status === 409) return { ok: false, conflict: true, mtime: body?.mtime ?? null };
    if (!res.ok || !body?.file)
      return { ok: false, error: body?.error ?? `save failed (${res.status})` };
    return { ok: true, file: body.file };
  } catch {
    return { ok: false, error: "Couldn't reach this machine." };
  }
}

async function gitPost<T>(hostId: string, path: string, body: object): Promise<T | null> {
  const cfg = await deviceForHost(hostId);
  if (!cfg) return null;
  try {
    const res = await fetch(`${await bridgeBase(cfg)}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export function gitCommit(hostId: string, cwd: string, message: string) {
  return gitPost<{ ok: boolean; sha?: string; error?: string }>(hostId, "/v1/git/commit", {
    cwd,
    message,
  });
}
export function gitPush(hostId: string, cwd: string) {
  return gitPost<{ ok: boolean; output?: string }>(hostId, "/v1/git/push", { cwd });
}

export interface MarkerOverride {
  threadId: string;
  eventId: string;
  marked: boolean;
}

/**
 * Mirror a marker toggle to the machine that owns the thread.
 *
 * Fire-and-forget: markers are an override layer over a default the client
 * computes itself, so the local collection stays authoritative for rendering
 * and a failed push costs cross-device visibility, never the user's own state.
 * `marked: null` clears the override (the toggle landed back on the default).
 */
export function pushMarker(
  hostId: string,
  threadId: string,
  eventId: string,
  marked: boolean | null,
) {
  return gitPost<{ ok: boolean }>(hostId, "/v1/markers", { threadId, eventId, marked });
}

/** Overrides the bridge holds for one thread — markers made on another device. */
export async function fetchThreadMarkers(
  hostId: string,
  threadId: string,
): Promise<MarkerOverride[]> {
  const cfg = await deviceForHost(hostId);
  if (!cfg) return [];
  try {
    const { markers } = await get<{ markers: MarkerOverride[] }>(
      cfg,
      `/v1/markers?thread=${encodeURIComponent(threadId)}`,
      15_000,
    );
    return markers ?? [];
  } catch {
    return []; // a failed read is never authoritative — merge nothing
  }
}
export function gitPR(
  hostId: string,
  cwd: string,
  opts?: { title?: string; body?: string; draft?: boolean },
) {
  return gitPost<{ ok: boolean; url?: string; error?: string }>(hostId, "/v1/git/pr", {
    cwd,
    ...opts,
  });
}

/** Create + switch to a new branch (before committing work made on main). */
export function gitBranch(hostId: string, cwd: string, name: string) {
  return gitPost<{ ok: boolean; error?: string }>(hostId, "/v1/git/branch", { cwd, name });
}

/** Model-generated branch/commit/PR metadata for the working tree. Nothing is
 *  applied — the caller must get explicit user approval first. */
export interface GitSuggestion {
  ok: boolean;
  error?: string;
  branchName?: string;
  commitMessage?: string;
  prTitle?: string;
  prBody?: string;
}
export function gitSuggest(hostId: string, cwd: string) {
  return gitPost<GitSuggestion>(hostId, "/v1/git/suggest", { cwd });
}

/** The host's direct-sync identity (so the app can sync off-LAN, not just via
 *  this bridge). Returned by the bridge after talking to the daemon. */
export async function fetchPairing(cfg: BridgeConfig): Promise<PairPayload | null> {
  try {
    const { pairing } = await get<{ pairing: PairPayload | null }>(cfg, "/v1/pair");
    return pairing ?? null;
  } catch {
    return null;
  }
}

/** Register an Expo push token with every configured device's bridge. */
export async function registerPushToken(token: string): Promise<void> {
  const configs = await listDeviceConfigs();
  await Promise.all(
    configs.map(async (cfg) => {
      try {
        await fetch(`${await bridgeBase(cfg)}/v1/push/register`, {
          method: "POST",
          headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
          body: JSON.stringify({ token }),
        });
      } catch {
        /* device offline — will re-register on next connect */
      }
    }),
  );
}

/** Halt a running agent turn on its host. Returns whether the daemon accepted. */
/** Status of the host's agent runtime (the bridge's native agent host). */
export interface DaemonInfo {
  running: boolean;
  pid: number | null;
  /** ISO time the daemon process started — surfaced so a stale daemon is visible. */
  startedAt: string | null;
  uptimeSecs: number | null;
  /** Turns the bridge is currently streaming — a restart while >0 needs `force`. */
  activeTurns: number;
}

/** Fetch the host daemon's status (start time, uptime, busy). null on any error. */
export async function fetchDaemon(hostId: string): Promise<DaemonInfo | null> {
  const cfg = await deviceForHost(hostId);
  if (!cfg) return null;
  try {
    const { daemon } = await get<{ daemon: DaemonInfo }>(cfg, "/v1/daemon");
    return daemon;
  } catch {
    return null;
  }
}

/**
 * Restart the host's agent daemon so it re-indexes recent sessions. Refuses with
 * `{ busy: true }` if a turn is in flight unless `force` is set.
 */
export async function restartDaemon(
  hostId: string,
  force = false,
): Promise<{ ok: boolean; busy?: boolean; daemon?: DaemonInfo }> {
  const cfg = await deviceForHost(hostId);
  if (!cfg) return { ok: false };
  try {
    const res = await fetch(
      `${await bridgeBase(cfg)}/v1/daemon/restart${force ? "?force=1" : ""}`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${cfg.token}` },
      },
    );
    const j = (await res.json()) as { restarted?: boolean; daemon?: DaemonInfo; error?: string };
    if (res.status === 409) return { ok: false, busy: true, daemon: j.daemon };
    return { ok: !!j.restarted, daemon: j.daemon };
  } catch {
    return { ok: false };
  }
}

export async function interruptTurn(
  hostId: string,
  agent: string,
  threadId: string,
): Promise<boolean> {
  const cfg = await deviceForHost(hostId);
  if (!cfg) return false;
  try {
    const res = await fetch(`${await bridgeBase(cfg)}/v1/turn/interrupt`, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
      body: JSON.stringify({ agent, threadId }),
    });
    const j = (await res.json()) as { ok?: boolean };
    return !!j.ok;
  } catch {
    return false;
  }
}

/** Fetch the host's Pounce Doctor report (what's installed/found/reachable). */
export async function fetchDoctor(hostId: string): Promise<DoctorReport | null> {
  const cfg = await deviceForHost(hostId);
  if (!cfg) return null;
  try {
    const { report } = await get<{ report: DoctorReport }>(cfg, "/v1/doctor");
    return report;
  } catch {
    return null;
  }
}

/** Read the host's manual overrides (pinned binary paths, extra PATH/env). */
export async function fetchHostConfig(hostId: string): Promise<PounceConfig | null> {
  const cfg = await deviceForHost(hostId);
  if (!cfg) return null;
  try {
    const { config } = await get<{ config: PounceConfig }>(cfg, "/v1/config");
    return config;
  } catch {
    return null;
  }
}

/** Persist a manual-override patch on the host. `bins`/`env` merge (""→clear a
 *  key); the host re-detects agents on the next sync. Returns the new config. */
export async function saveHostConfig(
  hostId: string,
  patch: {
    bins?: Record<string, string>;
    extraPath?: string[];
    env?: Record<string, string>;
    /** Anthropic Admin API key for official org spend; "" clears it. Write-only —
     *  the response reports `adminApiKeySet`, never the value. */
    adminApiKey?: string;
  },
): Promise<PounceConfig | null> {
  const cfg = await deviceForHost(hostId);
  if (!cfg) return null;
  try {
    const res = await fetch(`${await bridgeBase(cfg)}/v1/config`, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    const j = (await res.json()) as { config?: PounceConfig };
    return j.config ?? null;
  } catch {
    return null;
  }
}

/** Answer a pending ACP permission prompt (from a permission_request event).
 *  `optionId` null cancels. Resolves the paused turn on the host. */
export async function respondPermission(
  hostId: string,
  requestId: string,
  optionId: string | null,
): Promise<boolean> {
  const cfg = await deviceForHost(hostId);
  if (!cfg) return false;
  try {
    const res = await fetch(`${await bridgeBase(cfg)}/v1/turn/permission`, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
      body: JSON.stringify({ requestId, optionId }),
    });
    const j = (await res.json()) as { ok?: boolean };
    return !!j.ok;
  } catch {
    return false;
  }
}

/** Answer a pending interactive prompt (from a prompt_request event) by picking
 *  option `optionIndex`. Generic across trust / permission / plan / AskUserQuestion
 *  — the host moves the on-screen highlight there and presses Enter. */
export async function respondPrompt(
  hostId: string,
  threadId: string,
  optionIndex: number,
): Promise<boolean> {
  const cfg = await deviceForHost(hostId);
  if (!cfg) return false;
  try {
    const res = await fetch(`${await bridgeBase(cfg)}/v1/session/prompt/answer`, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
      body: JSON.stringify({ threadId, optionIndex }),
    });
    const j = (await res.json()) as { ok?: boolean };
    return !!j.ok;
  } catch {
    return false;
  }
}

/** Send raw input to a PTY-hosted session — free-form prompt replies, ↑/↓
 *  steering, Esc, Ctrl-C. `data` is written to the CLI's stdin verbatim (append
 *  "\r" to submit typed text). The generic escape hatch behind the prompt card. */
export async function sendSessionInput(
  hostId: string,
  threadId: string,
  data: string,
): Promise<boolean> {
  const cfg = await deviceForHost(hostId);
  if (!cfg) return false;
  try {
    const res = await fetch(`${await bridgeBase(cfg)}/v1/session/input`, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
      body: JSON.stringify({ threadId, data }),
    });
    const j = (await res.json()) as { ok?: boolean };
    return !!j.ok;
  } catch {
    return false;
  }
}

/** Launch a PTY-hosted interactive claude session (its prompts — AskUserQuestion,
 *  … — become answerable from the app). Returns the real threadId, or null.
 *
 *  Pass an existing `threadId` to CONTINUE that session (the bridge reuses its
 *  live PTY or `--resume`s it) instead of spawning a fresh one — so a test
 *  thread stays a single thread across relaunches. */
export async function startInteractive(
  hostId: string,
  text: string,
  cwd: string | null,
  threadId?: string,
): Promise<string | null> {
  const cfg = await deviceForHost(hostId);
  if (!cfg) return null;
  try {
    const res = await fetch(`${await bridgeBase(cfg)}/v1/session/interactive`, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
      body: JSON.stringify({ text, cwd, threadId }),
    });
    const j = (await res.json()) as { threadId?: string };
    return j.threadId ?? null;
  } catch {
    return null;
  }
}

export interface RepoEntry {
  path: string;
  type: "file" | "dir";
}

/** List files/folders under a session's cwd for @-mention autocomplete. */
export async function fetchFiles(hostId: string, cwd: string, query: string): Promise<RepoEntry[]> {
  const cfg = await deviceForHost(hostId);
  if (!cfg) return [];
  try {
    const { files } = await get<{ files: RepoEntry[] }>(
      cfg,
      `/v1/files?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(query)}`,
    );
    return files;
  } catch {
    return [];
  }
}

export interface DirEntry {
  name: string;
  path: string;
  /** Directory contains a `.git` — show it as a repo. */
  isRepo: boolean;
}
export interface DirListing {
  /** Absolute path currently listed. */
  path: string;
  /** Parent directory, or null at the browse root (home). */
  parent: string | null;
  home: string;
  entries: DirEntry[];
}

/** Browse folders on a device to pick a working directory for a new thread. */
export async function browseDirs(hostId: string, dirPath?: string): Promise<DirListing | null> {
  const cfg = await deviceForHost(hostId);
  if (!cfg) return null;
  try {
    return await get<DirListing>(
      cfg,
      `/v1/dirs${dirPath ? `?path=${encodeURIComponent(dirPath)}` : ""}`,
    );
  } catch {
    return null;
  }
}

/**
 * Stream a turn: runs the agent on the host and invokes `onEvent` for each item
 * update as it arrives (real-time). Resolves when the turn completes. The
 * transport-specific streaming (nitro-fetch on mobile, XHR on desktop) lives
 * behind the streamTurn seam; this function only parses the SSE frames.
 */
export interface TurnOptions {
  readonly images?: readonly RunImage[];
  readonly permissionMode?: PermissionMode;
  readonly reasoningEffort?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  readonly model?: string;
}

/** How long a sent turn may go unacknowledged before we declare it undelivered.
 *  Generous: an off-LAN send may first have to dial the iroh tunnel cold. */
const TURN_ACK_TIMEOUT_MS = 30_000;

export async function streamLiveMessage(
  hostId: string,
  agent: string,
  threadId: string | null,
  cwd: string | null,
  text: string,
  onEvent: (ev: TimelineEvent) => void,
  opts: TurnOptions = {},
): Promise<{ threadId: string | null }> {
  const cfg = await deviceForHost(hostId);
  if (!cfg) throw new Error("device not found");
  let buf = "";
  let realThreadId: string | null = threadId;
  let finished = false;
  // The bridge echoes the user message as the very first SSE frame, right when
  // it accepts the turn — so "no frame yet" after a generous window means the
  // send never landed (dead tunnel, sleeping host). Fail then instead of
  // spinning forever on an optimistic bubble that sync will later erase.
  let acked = false;
  let abandoned = false;
  const parseFrames = (chunk: string) => {
    if (abandoned) return true; // ack timed out — stop reading late bytes
    acked = true;
    buf += chunk;
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const line = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      try {
        const data = JSON.parse(line.slice(5).trim()) as {
          event?: TimelineEvent;
          done?: boolean;
          threadId?: string;
        };
        if (data.event) onEvent(data.event);
        if (data.done) {
          if (data.threadId) realThreadId = data.threadId;
          finished = true;
        }
      } catch {}
    }
    // Stop the seam once the turn's terminal frame lands (see streamTurn).
    return finished;
  };
  const turn = streamTurn(
    `${await bridgeBase(cfg)}/v1/turn/stream`,
    {
      headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        agent,
        threadId,
        cwd,
        text,
        images: opts.images,
        permissionMode: opts.permissionMode,
        reasoningEffort: opts.reasoningEffort,
        model: opts.model,
      }),
    },
    parseFrames,
  );
  let ackTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      turn,
      new Promise<never>((_, reject) => {
        ackTimer = setTimeout(() => {
          if (!acked) {
            abandoned = true;
            reject(new Error("host didn't acknowledge the message — check the connection"));
          }
        }, TURN_ACK_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(ackTimer);
    // Never let the abandoned request surface as an unhandled rejection.
    if (abandoned) turn.catch(() => {});
  }
  return { threadId: realThreadId };
}

/** One machine, one row. Device ids are URL-derived, so re-pairing the same
 *  machine under a new port/bridge instance piles up duplicate device entries.
 *  After a device connects, any OTHER config that answers /v1/pair with the
 *  SAME tunnel nodeId (the machine-stable identity in ~/.pounce, shared by
 *  every bridge instance on that host) is that machine under a stale URL —
 *  remove it. Unreachable devices are never touched: a failed read is not
 *  authoritative (it may be a different, sleeping machine). */
export async function forgetSameHostDuplicates(keepId: string): Promise<void> {
  const keep = await deviceForHost(keepId);
  if (!keep) return;
  const keepPairing = await fetchPairing(keep);
  if (!keepPairing?.nodeId) return;
  const stale: string[] = [];
  for (const d of (await listDeviceConfigs()).filter((d) => d.id !== keepId)) {
    const p = await fetchPairing(d);
    if (p?.nodeId && p.nodeId === keepPairing.nodeId) stale.push(d.id);
  }
  if (!stale.length) return;
  for (const id of stale) {
    await removeDeviceConfig(id);
    forgetDevice(id);
  }
  reconcileDevices((await listDeviceConfigs()).map((c) => c.id));
}

/** Add a device (a machine's bridge) and load all devices' live data. */
export async function connectBridge(cfg: BridgeConfig): Promise<boolean> {
  connection$.status.set("connecting");
  const id = deviceId(cfg.url.replace(/\/$/, ""));
  // Only a brand-new pairing is rolled back on failure. An already-paired device
  // must survive a transient blip (bridge restart, cold daemon) — unpairing it
  // there would force a re-scan for what is really a momentary hiccup.
  const wasPaired = (await listDeviceConfigs()).some((d) => d.id === id);
  try {
    const dev = await addDeviceConfig(cfg.url, cfg.token);
    // Reachability (health) is the sole gate for "connected". Sync is best-effort:
    // a cold daemon returning nothing for a tick must not fail the connection or
    // unpair the device — it just retries on the next sync.
    await get<{ ok: boolean }>(dev, "/health", 8_000).catch(() => {
      throw new Error("bridge unreachable");
    });
    connection$.demo.set(false);
    connection$.activeHostId.set(dev.id);
    // Capture the host's off-LAN identity (tunnel nodeId/relay) while we CAN
    // reach it — bridgeBase needs it later at the gym, when the LAN URL is dead
    // and /v1/pair is unreachable. Best-effort and non-blocking.
    void fetchPairing(dev)
      .then(async (p) => {
        if (p?.nodeId) await SecureStore.setItemAsync(PAIRING_KEY, JSON.stringify(p));
      })
      .catch(() => {});
    // Progressive connect: stream threads so the list fills in as pages land.
    // Fall back to the batch sync if the stream path errors (older bridge, etc.).
    await syncLiveDataStreaming().catch(() => syncLiveData().catch(() => {}));
    connection$.status.set("connected");
    // Sweep same-machine duplicates (old ports/bridge instances) now that this
    // one is confirmed live. Best-effort, off the critical path.
    void forgetSameHostDuplicates(dev.id).catch(() => {});
    return true;
  } catch {
    if (!wasPaired) await removeDeviceConfig(id);
    connection$.status.set("disconnected");
    return false;
  }
}
