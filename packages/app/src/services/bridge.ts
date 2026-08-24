/**
 * Live data via the Pounce Bridge (apps/bridge/server.mjs running on the host).
 *
 * The bridge reads coding-agent sessions from the host's disk and exposes them
 * over HTTP; here we fetch that data and map the threads onto the app's
 * Project/Conversation model. On the LAN we hit the bridge's address directly;
 * off-LAN, bridgeBase() swaps in a loopback proxy that carries the same HTTP
 * over an iroh p2p tunnel (github.com/n0-computer/iroh) to the paired machine.
 */
import { Platform } from "react-native";
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
  mergeDevice,
  mergeWorkspace,
  reconcileDevices,
  setAgentCaps,
  setCachedModels,
  syncWorkspace,
  upsertHosts,
} from "../state/stores";
import { type ActivityPage, mergeActivity } from "./activity";
import {
  applyBridgeToken,
  deviceId,
  hostFromUrl,
  resolveAdoption,
  resolvePairing,
  resolveTunnelReach,
} from "./deviceIdentity";
import { addedViaFor, type AddedVia } from "./deviceProvenance";
import type { SettleOverrides } from "../state/settled";
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
  /** Wire name, kept for older bridges/apps. Mapped to `isResumable`. */
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

/**
 * Access this device holds because another machine's owner granted it, rather
 * than because someone scanned a QR here. Read-only, narrowed to a scope, and
 * with a clock on it — see apps/bridge/agents/access.mjs.
 */
export interface DeviceGrant {
  readonly id: string;
  /** `{kind:"full"}` or `{kind:"scoped", repoKeys, threads}`. */
  readonly scope: unknown;
  /** One line for the device row: "Everything", "pounce-mono", "3 spaces". */
  readonly summary: string;
  /** ISO, or null for a grant with no expiry. */
  readonly expiresAt: string | null;
  /** Who granted it — the peer's hostName, for the "expired" message. */
  readonly issuedBy: string;
}

/** A configured device (one machine's bridge). */
export interface DeviceConfig extends BridgeConfig {
  readonly id: string;
  readonly name: string;
  /** The bridge's own id for the machine, once we've heard it say so. Absent
   *  for a device paired to a bridge too old to report one. */
  readonly bridgeId?: string;
  /**
   * This machine's Iroh tunnel identity, when we learned one for THIS device.
   *
   * Distinct from the single global pairing that bridgeBase() has always fallen
   * back to: that one can only ever describe one machine, which was fine when a
   * phone had one Mac and is not fine now that peers are granted individually.
   */
  readonly nodeId?: string;
  readonly relay?: string | null;
  /** The QUIC handshake secret for this peer's per-grant tunnel. Not the bearer
   *  token — that still authenticates every HTTP request over it. */
  readonly tunnelToken?: string;
  /** Present only on a device we reached by being granted access to it. */
  readonly grant?: DeviceGrant;
  /**
   * True once `token` is a credential this bridge issued to US specifically,
   * rather than the shared one the QR hands out. From then on the bridge can
   * rotate its own token — an update, a reinstall — without dropping us.
   */
  readonly adopted?: boolean;
  /**
   * How this machine got into the list.
   *
   * Worth recording rather than inferring. A machine added over SSH is a
   * REMOTE one: its `url` is an address on its own network that nothing here
   * can reach, so it lives or dies by its tunnel — which makes "Offline" mean
   * something quite different for it than for a Mac on the same Wi-Fi, and
   * makes the difference worth showing. Absent on everything paired before
   * this existed, which reads as the ordinary case and is correct: SSH is the
   * only path that sets it.
   */
  readonly addedVia?: AddedVia;
  /**
   * The SSH target we reached it at — the alias or address as typed, not the
   * name the machine gave back.
   *
   * Recorded because those two are routinely different and nothing else can
   * bridge them: you add `pneucons-prod` and the machine calls itself
   * `ip-172-31-45-115`, so the Add-a-machine list has no way to tell that the
   * host it is offering has already been added. Provenance again beats
   * guessing — see `addedVia`. Absent on everything added before this, and on
   * every machine that didn't arrive over SSH.
   */
  readonly sshHost?: string;
  /**
   * Keep `name` — don't take the one the bridge reports.
   *
   * A bridge answers `/v1/status` with its own hostname on every sync, which is
   * right for a machine you paired by QR and wrong for one whose name was
   * settled when it was added: it would quietly rename `pneucons-prod` back to
   * `ip-172-31-45-115` seconds later, and the name would never survive. Set as
   * a plain property of the row rather than inferred from `addedVia`, so the
   * next path that settles a name at add time doesn't have to teach the sync
   * loop about itself.
   */
  readonly namePinned?: boolean;
}

const DEVICES_KEY = "pounce.devices";

function nameFromUrl(url: string): string {
  return hostFromUrl(url) ?? "device";
}

/**
 * Ask a bridge who it is, before it's a configured device. Best-effort: an
 * unreachable or older bridge just yields null and we fall back to the URL.
 *
 * The extras come along because a machine added over SSH is one we can only
 * reach through its tunnel — its `url` is an address on its own network, so
 * probing without the node id would always fail and every remote machine would
 * land with no bridgeId, which is what keys its threads. Dialling costs a QUIC
 * handshake, hence the longer wait when there's an identity to dial.
 */
async function probeBridgeId(
  url: string,
  token: string,
  extras: Partial<DeviceExtras> = {},
): Promise<string | null> {
  try {
    const { status } = await get<{ status: BridgeStatus }>(
      { url, token, ...extras } as BridgeConfig,
      "/v1/status",
      extras.nodeId ? 25_000 : 6_000,
    );
    return status?.bridgeId || null;
  } catch {
    return null;
  }
}

/** Stamp provenance on rows stored before we recorded it — see addedViaFor. */
function backfillAddedVia(d: DeviceConfig): DeviceConfig {
  const addedVia = addedViaFor(d);
  return addedVia === d.addedVia ? d : { ...d, addedVia };
}

export async function listDeviceConfigs(): Promise<DeviceConfig[]> {
  const raw = await SecureStore.getItemAsync(DEVICES_KEY);
  if (raw) return (JSON.parse(raw) as DeviceConfig[]).map(backfillAddedVia);
  // migrate legacy single-bridge config
  const old = await SecureStore.getItemAsync(BRIDGE_KEY);
  if (old) {
    const c = JSON.parse(old) as BridgeConfig;
    return [{ id: deviceId(c.url), name: nameFromUrl(c.url), url: c.url, token: c.token }];
  }
  return [];
}
/**
 * The paired machines to ASK, one entry per physical machine.
 *
 * A machine can appear in the stored list twice — paired by QR and then found
 * again on the LAN, or reachable at two addresses — because `resolvePairing`
 * only collapses that at ADD time, by bridgeId, which a bridge too old to
 * report one doesn't supply. Anything that fans out and combines the answers
 * has to defend itself: a duplicate silently doubled every figure on the
 * dashboard (tokens, sessions, messages and dollars all exactly 2×), which
 * reads as real growth rather than as a bug.
 *
 * Deliberately NOT folded into `listDeviceConfigs`, which stays the literal
 * store read. The management paths depend on that: `reconcileDevices` is handed
 * the full id list and would garbage-collect the surviving row's siblings, and
 * add/remove/token paths read-modify-write the stored array, so a deduped read
 * would delete configs on the next write and make a duplicate row invisible in
 * Settings — and therefore undeletable.
 *
 * `deviceId` decides sameness, so this and pairing agree on what one machine is.
 */
export async function hostsToQuery(): Promise<DeviceConfig[]> {
  const seen = new Map<string, DeviceConfig>();
  for (const d of await listDeviceConfigs()) {
    const key = deviceId(d.url, d.bridgeId);
    if (!seen.has(key)) seen.set(key, d);
  }
  return [...seen.values()];
}

async function writeDeviceConfigs(list: DeviceConfig[]): Promise<void> {
  await SecureStore.setItemAsync(DEVICES_KEY, JSON.stringify(list));
}
/** Extras a granted peer carries that a QR pairing does not: how to reach it
 *  off-LAN, the terms the access was given on, and — for a machine added over
 *  SSH — the name it calls itself, which we learn on the far side before the
 *  machine is reachable at all and which beats naming a server after its IP. */
type DeviceExtras = Pick<
  DeviceConfig,
  | "nodeId"
  | "relay"
  | "tunnelToken"
  | "grant"
  | "name"
  | "addedVia"
  | "sshHost"
  | "namePinned"
  // A device paired by one-time code adopted at redemption — recording it here
  // stops the next sync spending a POST re-adopting what it already holds.
  | "adopted"
>;

export async function addDeviceConfig(
  url: string,
  token: string,
  extras: Partial<DeviceExtras> = {},
): Promise<DeviceConfig> {
  url = url.replace(/\/$/, "");
  const list = await listDeviceConfigs();
  const bridgeId = await probeBridgeId(url, token, extras);
  const { configs, device } = resolvePairing<DeviceConfig>(
    list,
    { url, token, bridgeId, name: nameFromUrl(url) },
    (base) => base as DeviceConfig,
  );
  // Applied after resolvePairing so re-granting a machine we already hold
  // updates its terms in place rather than leaving the old expiry on the row.
  const withExtras = { ...device, ...extras };
  await writeDeviceConfigs(configs.map((d) => (d.id === device.id ? withExtras : d)));
  return withExtras;
}

/** The published default every bridge used before it minted its own token. */
const LEGACY_TOKEN = "pounce-bridge-local";

/**
 * Swap a legacy pairing's token for the one its bridge actually uses now.
 *
 * Bridges used to authenticate with a constant compiled into the source, which
 * meant anyone on the same network held the credential. New bridges mint a
 * random token and keep honouring the old one only briefly, and only for reads —
 * so a device still carrying it must upgrade on its next sync or start failing.
 * Done here rather than by re-pairing: the user should never see a second QR
 * code for something the two ends can settle between themselves.
 */
export async function rotateLegacyToken(cfg: DeviceConfig): Promise<DeviceConfig> {
  if (cfg.token !== LEGACY_TOKEN) return cfg;
  let fresh: string | null = null;
  try {
    const { token } = await get<{ token: string }>(cfg, "/v1/token", 10_000);
    fresh = typeof token === "string" && token && token !== LEGACY_TOKEN ? token : null;
  } catch {
    // An older bridge has no /v1/token, and an unreachable one gets another go
    // next sync. Either way the existing pairing is left exactly as it was.
  }
  if (!fresh) return cfg;
  const list = await listDeviceConfigs();
  const next = { ...cfg, token: fresh };
  await writeDeviceConfigs(list.map((d) => (d.id === cfg.id ? next : d)));
  return next;
}

/**
 * Take out a credential of this device's own, so the bridge rotating its shared
 * token can never drop us.
 *
 * The shared token is the one the QR hands out, and it is the same value for
 * every phone paired to that machine. That made rotation one-way and fatal:
 * `/v1/token` is the only way back and it needs the credential that just
 * stopped working, so an upgrade whose window elapsed while the phone was off,
 * a bridge reinstall, or a torn ~/.pounce left this app locked out for good —
 * showing a device list that just said nothing was online. Only the desktop app
 * could recover, by reading its own loopback /ui, because it IS the machine.
 *
 * Adopting costs one POST on the first sync after an update and nothing after
 * that. It grants no new authority — it is called with a credential that
 * already has it — it only stops us depending on a value the bridge may change.
 *
 * Best-effort throughout: an older bridge has no such route, an unreachable one
 * gets another go next sync, and either way the existing pairing is untouched.
 * A device we reached through a GRANT is skipped — that credential is the
 * peer's to expire, read-only by construction, and not ours to replace.
 */
/**
 * Trade a one-time pairing code off the QR for this device's own credential.
 *
 * The code authenticates this single call and nothing else — the bridge scopes
 * it to this route — so there is no window in which the app holds something
 * replayable. What comes back is the per-device token every later request uses,
 * plus the tunnel's handshake secret, which is issued here and by no other
 * route.
 *
 * Deliberately no `key`: the app has no stable row for this machine yet (the id
 * comes from the bridge's identity, resolved on connect). The next
 * adoptDeviceToken re-mints under the proper key and the bridge revokes this
 * placeholder row — see the revoke in /v1/device/adopt.
 */
export async function redeemPairCode(
  url: string,
  code: string,
): Promise<{ token: string; tunnelToken?: string } | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/v1/device/adopt`, {
      method: "POST",
      headers: { authorization: `Bearer ${code}`, "content-type": "application/json" },
      // No name: the app has no label for itself yet either. The bridge
      // defaults the row, and the next adopt (which knows cfg.name) fixes it.
      body: JSON.stringify({ platform: Platform.OS }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { token?: string; tunnelToken?: string };
    return typeof body?.token === "string" && body.token
      ? { token: body.token, tunnelToken: body.tunnelToken }
      : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function adoptDeviceToken(cfg: DeviceConfig): Promise<DeviceConfig> {
  // Re-adopt when the tunnel secret is missing: a device paired before the
  // secret was split from the bridge token holds no `tunnelToken`, and its
  // off-LAN dialling would keep presenting a value `serve` no longer accepts.
  // One extra POST, once, and only for those rows.
  if ((cfg.adopted && cfg.tunnelToken) || cfg.grant) return cfg;
  let fresh: string | null = null;
  let freshTunnel: string | null = null;
  try {
    const base = await bridgeBase(cfg);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const res = await fetch(`${base}/v1/device/adopt`, {
        method: "POST",
        headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
        // `cfg.id` is this app's own stable row for that machine, so a re-adopt
        // after a reinstall replaces one credential instead of stacking a
        // second one the owner cannot attribute to anything.
        body: JSON.stringify({ key: cfg.id, name: cfg.name, platform: Platform.OS }),
        signal: ctrl.signal,
      });
      if (res.ok) {
        const body = (await res.json()) as { token?: string; tunnelToken?: string };
        fresh = typeof body?.token === "string" && body.token ? body.token : null;
        freshTunnel = typeof body?.tunnelToken === "string" ? body.tunnelToken : null;
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Offline, or a bridge that predates the route. Try again next sync.
  }
  if (!fresh) return cfg;
  const list = await listDeviceConfigs();
  // A bridge that predates the split answers without a tunnelToken; there the
  // secret still IS the token we authenticated with, so record that rather than
  // leaving the field empty and re-adopting on every sync forever.
  const next = {
    ...cfg,
    token: fresh,
    adopted: true,
    tunnelToken: freshTunnel ?? cfg.tunnelToken ?? cfg.token,
  };
  await writeDeviceConfigs(list.map((d) => (d.id === cfg.id ? next : d)));
  return next;
}

/**
 * Adopt the token a bridge at `url` says it is using now, for every device
 * pointing there. Returns true if anything changed.
 *
 * Only a caller that learned the token from an UNAUTHENTICATED source may use
 * this — in practice the desktop app reading its own loopback `/ui`. That's the
 * one case where a stale credential is recoverable without re-pairing, because
 * the app and the bridge are the same machine.
 *
 * It exists because token rotation is otherwise one-way: `/v1/token` needs the
 * very credential that's wrong, and the legacy grace window closes. Anything
 * that changes a bridge's token behind a paired client's back — a reinstall, a
 * deleted ~/.pounce, a downgrade to a bridge that predates minting — would
 * otherwise lock the app out of its own machine for good, with a device list
 * that just says nothing is online.
 */
/** Write a machine's tunnel identity onto its own device row, skipping the
 *  write when the row already says exactly this. Safe to call from racing
 *  healing paths — a lost update is re-stamped on the next connect. */
async function stampDeviceTunnelIdentity(
  id: string,
  nodeId: string,
  relay: string | null,
): Promise<void> {
  const list = await listDeviceConfigs();
  const cur = list.find((d) => d.id === id);
  if (!cur || (cur.nodeId === nodeId && (cur.relay ?? null) === relay)) return;
  await writeDeviceConfigs(list.map((d) => (d.id === id ? { ...d, nodeId, relay } : d)));
}

/**
 * Make sure a device row carries its OWN tunnel identity (nodeId/relay), so
 * off-LAN dialling never depends on the single global pairing.
 *
 * The global pairing can only ever describe one machine — whichever scanned a
 * QR last — so with two paired Macs every other machine used to dial the wrong
 * node off-LAN, presenting a handshake secret that node refuses. Which machine
 * the app dialled depended on stored order and scan recency, so "works on
 * cellular" was a lottery: one asleep laptop, or one re-scan at the other Mac,
 * and the phone was dead off Wi-Fi while the LAN path hid it all day.
 * Stamping the identity on the row while the machine IS reachable is what lets
 * tunnelReach dial each machine as itself.
 *
 * Best-effort like its siblings above: an unreachable machine, or a bridge too
 * old for /v1/pair, leaves the row untouched and gets another go next connect.
 */
export async function ensureTunnelIdentity(cfg: DeviceConfig): Promise<DeviceConfig> {
  // A grant's identity is fixed at approval time (per-grant tunnel) — never
  // overwrite it with the machine-wide identity its /v1/pair would report.
  if (cfg.grant) return cfg;
  const pairing = await fetchPairing(cfg);
  if (!pairing?.nodeId) return cfg;
  const relay = pairing.relay ?? null;
  if (cfg.nodeId === pairing.nodeId && (cfg.relay ?? null) === relay) return cfg;
  await stampDeviceTunnelIdentity(cfg.id, pairing.nodeId, relay);
  return { ...cfg, nodeId: pairing.nodeId, relay };
}

export async function adoptBridgeToken(url: string, token: string): Promise<boolean> {
  const { configs, changed } = applyBridgeToken(await listDeviceConfigs(), url, token);
  if (changed) await writeDeviceConfigs(configs);
  return changed;
}

/**
 * Reconcile a configured device against the identity its bridge reports, moving
 * the rows of any duplicate onto the survivor. Returns the id to sync under.
 */
export async function adoptBridgeId(cfg: DeviceConfig, bridgeId: string): Promise<string> {
  if (cfg.bridgeId === bridgeId) return cfg.id;
  const list = await listDeviceConfigs();
  const { configs, survivorId, merges } = resolveAdoption(list, cfg, bridgeId);
  await writeDeviceConfigs(configs);
  for (const from of merges) mergeDevice(from, survivorId);
  return survivorId;
}

/**
 * Settle every configured device against the identity its bridge reports, and
 * return the resulting list.
 *
 * Probes only devices that haven't been identified yet, so this is a one-time
 * migration per device rather than per-sync overhead — and in parallel with a
 * short timeout, so an unreachable device costs one brief wait instead of
 * stalling the sync behind it. Adoption itself is sequential because each one
 * rewrites the stored config list.
 */
async function canonicalizeDevices(): Promise<DeviceConfig[]> {
  const list = await listDeviceConfigs();
  const pending = list.filter((d) => !d.bridgeId);
  if (!pending.length) return list;

  const ids = await Promise.all(pending.map((d) => probeBridgeId(d.url, d.token)));
  let changed = false;
  for (const [i, cfg] of pending.entries()) {
    const id = ids[i];
    if (!id) continue; // offline, or a bridge that can't name itself yet
    await adoptBridgeId(cfg, id);
    changed = true;
  }
  return changed ? listDeviceConfigs() : list;
}
export async function removeDeviceConfig(id: string): Promise<void> {
  const list = await listDeviceConfigs();
  await writeDeviceConfigs(list.filter((d) => d.id !== id));
}

/**
 * Forget a device we no longer have access to, and everything synced under it.
 *
 * Only ever called on the bridge's own word (`GrantEndedError`) or on a
 * `expiresAt` we were told at approval time — never on a failed read. That
 * distinction is the sync-authority rule: silence means "couldn't reach it", and
 * dropping a machine's threads because its lid was shut would be a data loss
 * dressed up as a feature.
 */
async function dropEndedGrant(cfg: DeviceConfig, reason: "expired" | "revoked"): Promise<void> {
  await removeDeviceConfig(cfg.id);
  // Sweep the rows too: reconcileDevices takes the surviving ids as the truth,
  // so the peer's threads, repos and host go with the config.
  reconcileDevices((await listDeviceConfigs()).map((c) => c.id));
  const who = cfg.grant?.issuedBy || cfg.name;
  // Say it once. A device disappearing from the list with no explanation reads
  // as a bug, and the user needs to know whether to ask for access again.
  void notifyOnce(
    `grant:${cfg.id}`,
    reason === "revoked" ? "Access withdrawn" : "Access expired",
    reason === "revoked"
      ? `${who} withdrew your access to its threads.`
      : `Your access to ${who} ran out. Ask again to keep reading its threads.`,
  );
}

/** Has this device's grant run out by the clock? Checked before we call, so an
 *  expiry is honoured even while the peer is unreachable — the access ended
 *  whether or not the machine that granted it is around to say so. */
function grantLapsed(cfg: DeviceConfig): boolean {
  const at = cfg.grant?.expiresAt;
  return !!at && Date.parse(at) <= Date.now();
}

/** Drop granted devices whose clock has run out, and return the rest — the set
 *  a sync should actually talk to. */
async function dropLapsedGrants(configs: DeviceConfig[]): Promise<DeviceConfig[]> {
  const lapsed = configs.filter(grantLapsed);
  for (const cfg of lapsed) await dropEndedGrant(cfg, "expired");
  return lapsed.length ? configs.filter((c) => !lapsed.includes(c)) : configs;
}
/** The saved config for a host, or null if it isn't paired. Exported for
 *  ./terminal.ts, which owns its own transport but still has to reach the same
 *  device list and token this module resolves. */
export async function deviceForHost(hostId: string): Promise<DeviceConfig | null> {
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

/** Resolutions already underway, so a burst of parallel requests to one
 *  machine (a sync's status/agents/threads) shares a single LAN-probe/tunnel
 *  dial instead of racing three of them — which off-LAN meant three concurrent
 *  20s dial attempts per unreachable machine, serially delaying the whole
 *  sync's completion. */
const inflightBase = new Map<string, Promise<string>>();

/** The base URL requests should actually use for `cfg`: the LAN address when
 *  reachable, else the Iroh loopback proxy when a pairing is saved and the
 *  native tunnel is in this build. Cached briefly so every request doesn't
 *  re-probe; a failed LAN probe re-checks sooner than a healthy one. */
export async function bridgeBase(cfg: BridgeConfig): Promise<string> {
  const hit = effectiveBase.get(cfg.url);
  if (hit && Date.now() < hit.until) return hit.base;
  const underway = inflightBase.get(cfg.url);
  if (underway) return underway;
  const resolution = resolveBridgeBase(cfg).finally(() => inflightBase.delete(cfg.url));
  inflightBase.set(cfg.url, resolution);
  return resolution;
}

async function resolveBridgeBase(cfg: BridgeConfig): Promise<string> {
  if (await probeHealth(cfg.url, 2500)) {
    effectiveBase.set(cfg.url, { base: cfg.url, until: Date.now() + 30_000 });
    return cfg.url;
  }
  try {
    const reach = await tunnelReach(cfg);
    if (reach) {
      const port = await dialTunnel(reach.nodeId, reach.relay, reach.token);
      const base = port ? `http://127.0.0.1:${port}` : null;
      // Confirm end-to-end (QUIC dial happens on this first request).
      if (base && (await probeHealth(base, 20_000))) {
        effectiveBase.set(cfg.url, { base, until: Date.now() + 60_000 });
        return base;
      }
    }
  } catch {
    // fall through to the LAN URL — callers surface their own errors
  }
  effectiveBase.set(cfg.url, { base: cfg.url, until: Date.now() + 10_000 });
  return cfg.url;
}

/**
 * Which tunnel identity to dial for `cfg`, and with what handshake secret.
 *
 * A device's OWN identity wins. The global pairing below it can only ever
 * describe one machine — fine when a phone had one paired Mac, wrong now that
 * peers are granted individually, since every granted peer would otherwise be
 * dialed at whichever machine happened to scan a QR last.
 *
 * The two carry different secrets, too: a QR pairing's tunnel is gated on the
 * bridge's own token, while a grant's per-grant tunnel has a handshake secret of
 * its own (the grant token is not accepted there — see access.mjs).
 */
async function tunnelReach(
  cfg: BridgeConfig,
): Promise<{ nodeId: string; relay: string | null; token: string } | null> {
  const dev = cfg as DeviceConfig;
  if (dev.nodeId) return resolveTunnelReach(dev, null);
  const raw =
    (await SecureStore.getItemAsync(PAIRING_KEY)) ??
    (await SecureStore.getItemAsync(LEGACY_PAIRING_KEY));
  const pairing = raw ? (JSON.parse(raw) as PairPayload) : null;
  return resolveTunnelReach(dev, pairing);
}

/**
 * Open a loopback proxy onto a peer's tunnel, whichever way this build can.
 *
 * Mobile carries the tunnel client as a native module. Desktop does not — but it
 * ships the bridge, which is sitting on the same machine and can run
 * `pounce-tunnel client` on our behalf and hand back a port.
 */
async function dialTunnel(
  nodeId: string,
  relay: string | null,
  token: string,
): Promise<number | null> {
  const { tunnelAvailable, startTunnel } = await import("./tunnel");
  if (tunnelAvailable()) return startTunnel(nodeId, relay, token);
  return dialViaLocalBridge(nodeId, relay, token);
}

/** Ask the bridge on THIS machine to dial the peer for us — an authenticated,
 *  loopback-only owner route; see dialPeer in ./ownBridge. */
async function dialViaLocalBridge(
  nodeId: string,
  relay: string | null,
  token: string,
): Promise<number | null> {
  const { dialPeer } = await import("./ownBridge");
  return dialPeer(nodeId, relay, token);
}

// Back-compat single-config helpers (used by older call sites / Settings).
export async function saveBridgeConfig(cfg: BridgeConfig): Promise<void> {
  await SecureStore.setItemAsync(BRIDGE_KEY, JSON.stringify(cfg));
  await addDeviceConfig(cfg.url, cfg.token);
}
/**
 * The device to connect to — the first one that ANSWERS, not simply the first
 * one stored.
 *
 * This used to be `devs[0]`, and that made one unreachable machine fatal to the
 * whole app. `connectBridge` treats an unreachable device as a failed
 * connection, so the status never leaves "disconnected" — and because thread
 * sync only runs once connected, a laptop that happened to sort first and was
 * closed for the weekend stopped a perfectly healthy local bridge from ever
 * syncing. The symptom is the worst kind: Spaces and Sessions sit empty
 * forever, while the machine you're sitting at is two inches away and fine.
 *
 * Order is still respected — the first reachable device wins, so a deliberate
 * primary keeps its place. Probes run in parallel and only when there is more
 * than one device, so the common single-bridge case costs nothing extra. If
 * NOTHING answers we still return the first: the caller's own failure path
 * ("disconnected", keep cached threads) is the right answer then, and returning
 * null instead would read as "not paired" and prompt for a QR scan.
 */
export async function loadBridgeConfig(): Promise<BridgeConfig | null> {
  const devs = await listDeviceConfigs();
  if (devs.length <= 1) return devs[0] ?? null;
  const reachable = await Promise.all(devs.map((d) => probeHealth(d.url, 2500)));
  return devs[reachable.findIndex(Boolean)] ?? devs[0];
}
export async function clearBridgeConfig(): Promise<void> {
  await SecureStore.deleteItemAsync(BRIDGE_KEY);
  await SecureStore.deleteItemAsync(DEVICES_KEY);
}

/**
 * The bridge told us this credential is finished — not that it couldn't be
 * reached.
 *
 * The distinction is the whole point. Sync treats any failure as "offline" and
 * keeps the last-known threads on screen, which is right for a closed laptop and
 * wrong for a grant that ran out: those rows are no longer ours to show. Only an
 * explicit answer from the bridge counts; a timeout never does.
 */
export class GrantEndedError extends Error {
  constructor(
    readonly reason: "grant_expired" | "grant_revoked",
    readonly expiresAt: string | null,
  ) {
    super(reason);
    this.name = "GrantEndedError";
  }
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
    if (!res.ok) {
      if (res.status === 401) await throwIfGrantEnded(res);
      // A route this bridge does not have is a stale bridge, not a failure of
      // the machine or the network — and callers that can say so usefully need
      // to be able to tell the difference.
      if (res.status === 404) throw new RouteMissingError(path);
      throw new Error(`bridge ${path} -> ${res.status}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** Reads a 401 body for the bridge's specific "this grant is over" answer.
 *  Body-reading failures fall through — an unparseable 401 is just a 401. */
async function throwIfGrantEnded(res: Response): Promise<void> {
  let body: { error?: string; expiresAt?: string } | null = null;
  try {
    body = (await res.clone().json()) as { error?: string; expiresAt?: string };
  } catch {
    return;
  }
  if (body?.error === "grant_expired" || body?.error === "grant_revoked") {
    throw new GrantEndedError(body.error, body.expiresAt ?? null);
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
  /** Stable per-machine id; absent on bridges older than it. */
  bridgeId?: string;
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
        isResumable: t.isLive,
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
  // Settle identities BEFORE fanning out: adoption can collapse two configs into
  // one, and doing that inside the parallel map would race two syncs writing the
  // same device. Only runs while some device predates `bridgeId`, so it costs
  // nothing once every paired bridge has been heard from.
  const configs = await dropLapsedGrants(await canonicalizeDevices());
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
    configs.map(async (rawCfg) => {
      // Before anything else this sync: retire a token that used to be public,
      // take out one of our own so a future rotation can't drop us, then learn
      // this machine's own tunnel identity so it stays dialable off-LAN. All
      // three are no-ops after they have happened once.
      const cfg = await ensureTunnelIdentity(
        await adoptDeviceToken(await rotateLegacyToken(rawCfg)),
      );
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
        deviceName = cfg.namePinned ? cfg.name : status?.device || cfg.name;
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
          addedVia: cfg.addedVia,
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
      } catch (e) {
        // The bridge saying our grant is over is not the same as failing to
        // reach it: forget the machine outright rather than parking it as
        // offline with threads we may no longer show.
        if (e instanceof GrantEndedError) {
          await dropEndedGrant(cfg, e.reason === "grant_revoked" ? "revoked" : "expired");
          delete threadsByDevice[cfg.id];
          delete devices[cfg.id];
          return;
        }
        online = false;
        devices[cfg.id] = {
          id: cfg.id,
          name: deviceName,
          url: cfg.url,
          online: false,
          agents: agentsAvail as Device["agents"],
          sessionCount: threadsByDevice[cfg.id].threads.length,
          lastSyncAt: now,
          addedVia: cfg.addedVia,
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
  const configs = await dropLapsedGrants(await hostsToQuery());
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
        deviceName = cfg.namePinned ? cfg.name : status?.device || cfg.name;
        agentsReported = (agents || []).length;
        agentsAvail = (agents || []).filter((a) => a.available).map((a) => a.id);
        // Record per-agent capabilities so the composer can gate its controls.
        for (const a of agents || []) {
          if (a.capabilities) setAgentCaps(a.id, a.capabilities);
        }
        threads = t.threads;
        syncedHostIds.push(cfg.id);
      } catch (e) {
        // Access ended (not merely unreachable) — forget the machine and its rows.
        if (e instanceof GrantEndedError) {
          await dropEndedGrant(cfg, e.reason === "grant_revoked" ? "revoked" : "expired");
          return;
        }
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
        addedVia: cfg.addedVia,
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
          isResumable: t.isLive,
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
  const devices = opts?.hostId
    ? (await listDeviceConfigs()).filter((d) => d.id === opts.hostId)
    : await hostsToQuery();
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

/**
 * Markdown image references by ABSOLUTE PATH — `![shot](/var/folders/…)` in an
 * assistant reply — name files on the THREAD'S HOST. Every other device (phone,
 * another Mac, the web shell) resolves that path against itself and draws a
 * broken image. Same answer as the Read-tool previews: point the reference at
 * the host's token-authed /v1/file. http(s)/data: targets pass through
 * untouched. Applied on both the settled fetch and the live SSE stream, so a
 * screenshot renders mid-turn, not just after the next sync.
 */
/** A host file as a loadable, token-authed URL (same shape as the Read-tool
 *  previews below). */
const hostedFileUrl = (base: string, token: string, filePath: string) =>
  `${base}/v1/file?path=${encodeURIComponent(filePath)}&token=${encodeURIComponent(token)}`;

function withHostedMarkdownImages(e: TimelineEvent, base: string, token: string): TimelineEvent {
  if (e.type !== "assistant_message" && e.type !== "user_message") return e;
  // Cheap pre-filter — this runs per SSE frame on the live path, and streaming
  // events carry the full accumulated text. http(s)/data: image targets don't
  // need rewriting, so only absolute-path/file:// candidates pay for the regex.
  if (!e.text.includes("](/") && !e.text.includes("](file://")) return e;
  const text = e.text.replace(
    /(!\[[^\]\n]*\]\()(?:file:\/\/)?(\/[^)\s]+)(\))/g,
    (_m, open: string, path: string, close: string) =>
      `${open}${hostedFileUrl(base, token, path)}${close}`,
  );
  return text === e.text ? e : { ...e, text };
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
    e = withHostedMarkdownImages(e, base, cfg.token);
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
            previewUri: hostedFileUrl(base, cfg.token, fp),
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
  /**
   * The model the thread's most recent turn actually ran on — NOT the same
   * question as `model`, which is the thread's dominant one by output tokens.
   * A thread moved late in its life (an agent-side fallback, or someone typing
   * /model in a terminal) keeps reporting the old model there and the new one
   * here. This is what lets the app notice a model change it didn't make.
   */
  lastModel?: string | null;
  /** ISO timestamp of that turn, so a selection made *since* it isn't
   *  overwritten by an older observation. */
  lastModelAt?: string | null;
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
  const devices = await hostsToQuery();
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
 * turns a guess into a gauge (see @pounce/meter blocks).
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
 * What the user has said about each thread, merged across machines.
 *
 * Bridge-owned rather than local, so settling on the phone settles on the
 * desktop. Thread ids are unique per machine, so merging maps cannot collide;
 * a host that fails to answer simply contributes nothing rather than making
 * its threads look un-settled.
 */
export async function fetchSettled(): Promise<SettleOverrides> {
  const devices = await hostsToQuery();
  const pages = await Promise.all(
    devices.map(async (cfg) => {
      try {
        const { settled } = await get<{ settled: SettleOverrides }>(cfg, "/v1/settled");
        return settled ?? {};
      } catch {
        return {};
      }
    }),
  );
  return Object.assign({}, ...pages);
}

/**
 * Settle a thread as of now, or un-settle it with `settledAt: null`.
 *
 * Returns the host's whole map so the caller replaces rather than patches — the
 * machine is the authority on what it now believes, and a patch would drift if
 * a write raced a sync.
 */
export async function setSettled(
  hostId: string,
  threadId: string,
  state: "settled" | "active" | null,
  at: string,
): Promise<SettleOverrides> {
  const cfg = await deviceForHost(hostId);
  if (!cfg) throw new Error("That machine isn't paired any more.");
  const res = await fetch(`${await bridgeBase(cfg)}/v1/settled`, {
    method: "POST",
    headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
    body: JSON.stringify({ threadId, state, at }),
  });
  if (!res.ok) throw new Error(`bridge /v1/settled -> ${res.status}`);
  const { settled } = (await res.json()) as { settled: SettleOverrides };
  return settled ?? {};
}

/** One worktree an agent left on a machine, with what it costs and what would
 *  be lost by taking it back. */
export interface WorktreeRow {
  hostId: string;
  path: string;
  /** The directory's own name — what the worktree is called day to day. */
  name: string;
  /** Project it was cut from, or null when nothing can place it. */
  repo: string | null;
  branch: string | null;
  /** Agent whose threads last ran here; null when no thread claims it. */
  agent: string | null;
  /** Measured size, or null when the host couldn't measure it. Never 0 for
   *  "unknown" — the two mean different things on this screen. */
  bytes: number | null;
  threads: number;
  lastActivityAt: string | null;
  idleDays: number | null;
  /** Uncommitted files. Above zero, deleting destroys work. `null` when git
   *  couldn't be asked at all (a pruned worktree) — which is not the same as
   *  clean, and is never shown as such. */
  dirtyFiles: number | null;
  /** Commits that exist on no remote, or null when git couldn't say. */
  unpushed: number | null;
  lastThreadId: string | null;
}

export interface DiskReport {
  hostId: string;
  scannedAt: string;
  /** Floor, not exact: rows the host couldn't measure contribute nothing. */
  totalBytes: number;
  unmeasured: number;
  agents: { agent: string | null; bytes: number; worktrees: number }[];
  worktrees: WorktreeRow[];
}

/** What a removal did, or why it declined to. */
export type RemoveWorktreeResult =
  | {
      ok: true;
      path: string;
      branch: string | null;
      branchDeleted: boolean;
      unpushed: number | null;
    }
  | {
      ok: false;
      reason: "dirty";
      /** null = the host couldn't check, not "zero files". */
      dirtyFiles: number | null;
      unpushed: number | null;
      branch: string | null;
      lastThreadId: string | null;
      lastThreadAgent: string | null;
    }
  | { ok: false; reason: "unknown" | "gone" | "failed"; branch?: string | null };

/**
 * Worktree disk usage across every paired device, one report per machine.
 *
 * Kept per-host rather than merged: a path only means something on the machine
 * it's on, and reclaiming space is something you do to one machine at a time.
 */
export async function fetchDisk(opts?: { fresh?: boolean }): Promise<DiskReport[]> {
  const devices = await hostsToQuery();
  const pages = await Promise.all(
    devices.map(async (cfg) => {
      try {
        // Measuring trees is slow on a cold cache — a long timeout, and the
        // host caches the answer for everyone else.
        const r = await get<Omit<DiskReport, "hostId">>(
          cfg,
          `/v1/disk${opts?.fresh ? "?fresh=1" : ""}`,
          120_000,
        );
        return [{ ...r, hostId: cfg.id }];
      } catch {
        return [];
      }
    }),
  );
  return pages.flat().sort((a, b) => b.totalBytes - a.totalBytes);
}

/**
 * Delete one worktree on one machine.
 *
 * `force` is the user having been told it holds uncommitted work and said to
 * do it anyway; `deleteBranch` is a separate answer to a separate question, and
 * neither is ever inferred from the other.
 */
export async function removeWorktree(
  hostId: string,
  path: string,
  opts?: { force?: boolean; deleteBranch?: boolean },
): Promise<RemoveWorktreeResult> {
  const cfg = await deviceForHost(hostId);
  if (!cfg) throw new Error("That machine isn't paired any more.");
  const res = await fetch(`${await bridgeBase(cfg)}/v1/disk/worktree/remove`, {
    method: "POST",
    headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
    body: JSON.stringify({ path, force: !!opts?.force, deleteBranch: !!opts?.deleteBranch }),
  });
  if (!res.ok) throw new Error(`bridge /v1/disk/worktree/remove -> ${res.status}`);
  return (await res.json()) as RemoveWorktreeResult;
}

/**
 * Plan quota across every paired device. On a subscription this is the number
 * that actually means something — dollars don't exist to report. Agents with
 * nothing to say are simply absent.
 */
export async function fetchQuota(): Promise<AgentQuota[]> {
  const devices = await hostsToQuery();
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

/**
 * One node of the attribution tree, at any depth.
 *
 * The tree is deliberately uniform so the chart can drill without special cases:
 * a line item, a tool inside it, and that tool's own detail are all this shape.
 * Today it runs three deep — `Shell commands → git → status`,
 * `Tools · content read in → Read → *.ts` — and a node with nothing under it
 * simply carries an empty `children`.
 *
 * `folded` counts the rows a labelled "other" stands in for; such a node is
 * always a leaf, because its members came from different parents and there is
 * no honest breakdown to offer under the merge.
 */
export interface AttributionNode {
  key: string;
  tokens: number;
  perRequest: number;
  children: AttributionNode[];
  folded?: number;
}

/**
 * What filled a window — the breakdown behind the `blocks` figure on the Claude
 * quota card.
 *
 * Every total here is exact; only the SPLIT across line items is apportioned,
 * because Claude publishes no per-segment token counts. The report must say so,
 * which is what `preambleFittedShare` and `unattributed` are for: the first is
 * how much of the preamble was solved for rather than assumed, the second is
 * the rounding the breakdown failed to place.
 */
export interface Attribution {
  agent: string;
  windowHours: number;
  /** The instant the requested range starts at. Not the same as what was
   *  FOUND — see `earliestAt`. */
  windowStartedAt: string;
  /** The oldest turn actually billed to this report, or null when the range is
   *  empty. Asking for a year does not create a year: Claude prunes its own
   *  transcripts, so this is the span the page is entitled to claim. */
  earliestAt: string | null;
  /** True when the range is the agent's own rolling block (what the quota card
   *  reports) rather than a plain trailing window. */
  windowIsBlock: boolean;
  /** What the scan actually read. `truncated > 0` means some transcripts were
   *  too large to read in full for this range, so their oldest turns are not in
   *  the totals — measured rather than assumed, so the page can say so. */
  coverage: { files: number; truncated: number; unreadBytes: number };
  scannedSessions: number;
  requests: number;
  items: AttributionNode[];
  total: number;
  billedInput: number;
  billedOutput: number;
  unattributed: number;
  cacheRead: number;
  cacheWrite1h: number;
  cacheWrite5m: number;
  /** 1 when every contributing session's preamble was measured; below 1 when
   *  some fell back to a fixed ratio. The UI marks anything under 1 estimated. */
  preambleFittedShare: number;
  preamblePerRequest: number;
  /** How many times the model's own output was re-billed as input. Null when
   *  nothing was carried. */
  carryMultiplier: number | null;
}

/**
 * Attribution for ONE host. Deliberately not merged across devices: each
 * machine has its own transcripts, its own preamble and its own window, and
 * summing them would repeat the double-count trap that per-host cost totals
 * already have to avoid.
 */
export async function fetchAttribution(
  hostId: string,
  /** `"block"` asks for the agent's OWN rolling window — the one the quota card
   *  reports, which opens at your first message rather than N hours ago. A
   *  number is a plain trailing window in hours. */
  window: "block" | number = "block",
): Promise<Attribution | null> {
  const cfg = (await hostsToQuery()).find((d) => d.id === hostId);
  if (!cfg) return null;
  const q = window === "block" ? "window=block" : `hours=${window}`;
  const { attribution } = await get<{ attribution: Attribution | null }>(
    cfg,
    `/v1/attribution?${q}`,
    30_000,
  );
  return attribution ?? null;
}

/**
 * The same report, streamed — and the reason this page stopped timing out.
 *
 * Reading a window means walking every transcript it touched. The one-shot GET
 * above is silent for that entire walk, so on a busy machine it outlived the
 * 30s abort and the page said "the machine didn't answer in time" about a
 * machine that was working perfectly and would have answered a minute later.
 * Raising the timeout only moves the cliff; the fix is a connection that is
 * never idle.
 *
 * So the sessions queue up host-side as they are read, each one announced as it
 * lands, and `onProgress` lets the page show the queue filling. The analytics
 * still arrive in one piece at the end, on the complete set — a partial merge
 * would render a total that is wrong rather than unfinished.
 *
 * Falls back to {@link fetchAttribution} against a bridge that predates the
 * route: that machine keeps the old cliff, but it keeps working.
 */
/**
 * What a paired machine can do, by name — asked once, cached per host.
 *
 * This is the app's half of the contract in apps/bridge/agents/features.mjs.
 * Before it existed, a client found out what a bridge could do by calling it
 * and seeing what came back — which is how a desktop app on 1.6.2, attached to
 * a bridge five weeks older, ended up offering a page whose route that bridge
 * had never heard of and reporting the instant 404 as "didn't answer in time".
 *
 * An older bridge omits `features` entirely. That is not a failure to handle,
 * it IS the answer: a bridge that cannot name its capabilities is one from
 * before capabilities were named, so everything optional is off. Returned as an
 * empty set, which `hostSupports` reads as "gate it".
 *
 * Cached because it changes only when the bridge restarts, and a per-render
 * probe would put a network round trip in front of every screen that asks.
 */
const featureCache = new Map<string, { at: number; names: Set<string> }>();
const FEATURES_TTL_MS = 60_000;

export async function hostFeatures(hostId: string): Promise<Set<string>> {
  const hit = featureCache.get(hostId);
  if (hit && Date.now() - hit.at < FEATURES_TTL_MS) return hit.names;
  const cfg = (await hostsToQuery()).find((d) => d.id === hostId);
  if (!cfg) return new Set();
  try {
    const hello = await get<{ features?: string[] }>(cfg, "/v1/hello", 8_000);
    const names = new Set(hello.features ?? []);
    featureCache.set(hostId, { at: Date.now(), names });
    return names;
  } catch {
    // Unreachable is NOT the same as old, so this must not be cached — a
    // machine that was merely asleep would otherwise have every optional
    // feature hidden for a minute after it woke up.
    return new Set();
  }
}

/** Can this machine do `feature`? See FEATURES in the bridge for the names. */
export async function hostSupports(hostId: string, feature: string): Promise<boolean> {
  return (await hostFeatures(hostId)).has(feature);
}

/** One agent CLI's version, and whether this machine is behind on it. */
export interface AgentVersion {
  readonly id: string;
  readonly bin: string;
  readonly installed: string | null;
  readonly latest: string | null;
  /** null = we did not look, or the two versions cannot be honestly ranked
   *  (cursor-agent is a date plus a build sha). Render that as SILENCE — a
   *  missing badge is fine, a wrong one sends someone to reinstall a CLI that
   *  was already current. */
  readonly updateAvailable: boolean | null;
  /** The CLI's own updater, e.g. `opencode upgrade`. */
  readonly updateCommand: string | null;
}

/**
 * What each agent CLI on `hostId` is, and optionally whether it is behind.
 *
 * `check` is what costs a network round trip on the HOST — it asks npm (and,
 * for cursor-agent, reads the version out of its install script). Off by
 * default because the dashboard re-syncs every 20 seconds and nothing about a
 * CLI release schedule rewards asking that often.
 */
export async function fetchAgentVersions(
  hostId: string,
  { check = false }: { check?: boolean } = {},
): Promise<AgentVersion[]> {
  const cfg = (await hostsToQuery()).find((d) => d.id === hostId);
  if (!cfg) return [];
  const { agents } = await get<{ agents: AgentVersion[] }>(
    cfg,
    `/v1/agents/versions${check ? "?check=1" : ""}`,
    check ? 30_000 : 10_000,
  );
  return agents ?? [];
}

/**
 * Run an agent's own updater on `hostId`.
 *
 * `changed` is read back off disk afterwards rather than inferred from the exit
 * code: an updater that exits 0 without replacing anything (already current, or
 * an install it lacks permission to write) is a real case, and the caller has to
 * be able to tell it from an update that landed.
 */
export async function runAgentUpdate(
  hostId: string,
  agent: string,
): Promise<{ ok: boolean; changed?: boolean; installed?: string | null; output?: string }> {
  const cfg = (await hostsToQuery()).find((d) => d.id === hostId);
  if (!cfg) return { ok: false };
  const res = await fetch(`${await bridgeBase(cfg)}/v1/agents/update`, {
    method: "POST",
    headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
    body: JSON.stringify({ agent }),
  });
  return (await res.json()) as { ok: boolean; changed?: boolean; installed?: string | null };
}

/**
 * The machine answered, and said it has never heard of the route.
 *
 * Worth its own type because the page's advice is the opposite of the usual
 * one: a 404 here is a bridge too old to have the feature, so "Try again"
 * cannot ever work and telling someone to wait is telling them to wait
 * forever. It is also what a stale bridge looks like from the app — the quota
 * card beside it keeps working, because /v1/quota has existed for far longer,
 * which is exactly why the page appears reachable and then fails.
 */
export class RouteMissingError extends Error {
  constructor(readonly path: string) {
    super(`bridge ${path} -> 404`);
    this.name = "RouteMissingError";
  }
}

export async function streamAttribution(
  hostId: string,
  window: "block" | number = "block",
  onProgress?: (p: { scanned: number; total: number }) => void,
): Promise<Attribution | null> {
  const cfg = (await hostsToQuery()).find((d) => d.id === hostId);
  if (!cfg) return null;
  const q = window === "block" ? "window=block" : `hours=${window}`;
  const base = await bridgeBase(cfg);
  let buf = "";
  let report: Attribution | null = null;
  let streamError: string | null = null;
  let finished = false;
  let sawFrame = false;
  try {
    await streamTurn(
      `${base}/v1/attribution/stream?${q}`,
      { method: "GET", headers: { authorization: `Bearer ${cfg.token}` } },
      (chunk) => {
        sawFrame = true;
        buf += chunk;
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = frame.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          let d: {
            progress?: { scanned: number; total: number };
            attribution?: Attribution | null;
            done?: boolean;
            error?: string;
          } | null = null;
          try {
            d = JSON.parse(line.slice(5).trim());
          } catch {
            continue;
          }
          if (d?.progress) onProgress?.(d.progress);
          if (d?.attribution !== undefined) report = d.attribution;
          if (d?.error) streamError = d.error;
          if (d?.done || d?.error) finished = true;
        }
        return finished;
      },
    );
  } catch (e) {
    // Nothing came back at all — an older bridge 404s the route. One that
    // streamed and then died is a real failure and must not be retried as a
    // blocking read that would only time out again.
    if (sawFrame) throw e;
    return fetchAttribution(hostId, window);
  }
  if (streamError) throw new Error(streamError);
  return report;
}

/**
 * Write the attribution report to a file on the machine it describes, and
 * return where it landed.
 *
 * Host-side rather than a download because that is where the file is useful —
 * anything that might read it (an agent, a script) runs there — and because it
 * gives the phone and the desktop one behaviour instead of a share sheet on one
 * and nothing on the other.
 */
export async function exportAttribution(
  hostId: string,
  window: "block" | number = "block",
): Promise<string | null> {
  const cfg = await deviceForHost(hostId);
  if (!cfg) throw new Error("That machine isn't paired any more.");
  const res = await fetch(`${await bridgeBase(cfg)}/v1/attribution/export`, {
    method: "POST",
    headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
    body: JSON.stringify({
      ...(window === "block" ? { window: "block" } : { hours: window }),
      // Put up the OS save panel rather than picking a folder for them. It
      // opens on the machine the report is about, which is where the file has
      // to land anyway. The request stays open while the panel does.
      choose: true,
    }),
    // A save panel waits on a person, so this one request must not be raced by
    // the usual timeouts.
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (!res.ok) throw new Error(`bridge /v1/attribution/export -> ${res.status}`);
  const body = (await res.json()) as { path?: string; canceled?: boolean };
  // Dismissing the panel is an ordinary outcome, not a failure.
  return body.canceled ? null : (body.path ?? null);
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
 *  Never overwrites a good cache with an empty (error) result.
 *
 *  `force` skips both this throttle and the bridge's own cache. Opening the
 *  picker is a deliberate "show me the models", and answering that out of a
 *  cache up to two TTLs old is how the list came to look stale on a desktop app
 *  that had been open all week. */
const modelWarmAt = new Map<string, number>();
const MODEL_WARM_TTL = 10 * 60_000;
export async function warmModels(
  hostId: string,
  agent: string,
  opts?: { force?: boolean },
): Promise<void> {
  const key = `${hostId}:${agent}`;
  const last = modelWarmAt.get(key) ?? 0;
  if (!opts?.force && cachedModels(hostId, agent) && Date.now() - last < MODEL_WARM_TTL) return;
  modelWarmAt.set(key, Date.now());
  const models = await fetchModels(hostId, agent, opts);
  if (models.length) setCachedModels(hostId, agent, models);
  else modelWarmAt.delete(key); // let a failed warm retry sooner
}

/** Available models for an agent on a device (daemon model/list). [] on error. */
export async function fetchModels(
  hostId: string,
  agent: string,
  opts?: { force?: boolean },
): Promise<ModelInfo[]> {
  const cfg = await deviceForHost(hostId);
  if (!cfg) return [];
  try {
    const { models } = await get<{ models: ModelInfo[] }>(
      cfg,
      `/v1/models?agent=${encodeURIComponent(agent)}${opts?.force ? "&fresh=1" : ""}`,
    );
    return models ?? [];
  } catch {
    return [];
  }
}

/** One entry in the desktop app's "Open in" menu — an editor the host machine
 *  actually has installed, or its file manager. */
export interface EditorTarget {
  id: string;
  name: string;
}

/**
 * Editors installed on a host, for the "Open in" menu.
 *
 * Empty on any failure, including an older bridge that has no /v1/editors: the
 * caller hides the control rather than showing a menu of things that won't
 * open. A menu is a promise, and one we can't keep shouldn't be made.
 */
export async function listEditors(hostId: string): Promise<EditorTarget[]> {
  const cfg = await deviceForHost(hostId);
  if (!cfg) return [];
  try {
    const { editors } = await get<{ editors: EditorTarget[] }>(cfg, "/v1/editors", 10_000);
    return editors ?? [];
  } catch {
    return [];
  }
}

/**
 * Open a thread's project folder in one of them, on the machine that holds it.
 *
 * Resolves to an error string rather than throwing: this is a menu click, and
 * the worst outcome — a folder that no longer exists — deserves a line of text,
 * not a crash.
 */
export async function openInEditor(
  hostId: string,
  editor: string,
  cwd: string | null,
): Promise<{ ok: boolean; error?: string }> {
  const cfg = await deviceForHost(hostId);
  if (!cfg) return { ok: false, error: "device not found" };
  try {
    const res = await fetch(`${await bridgeBase(cfg)}/v1/open`, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
      body: JSON.stringify({ editor, cwd }),
    });
    return (await res.json()) as { ok: boolean; error?: string };
  } catch (e) {
    return { ok: false, error: String(e) };
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
/**
 * One skill an agent working in a project can reach.
 *
 * Read the way skills.sh lays them out rather than any single agent's, so
 * `agents` is the interesting field: a skill in the shared store is only
 * reachable by the agents whose farm links it.
 */
export interface SkillRow {
  name: string;
  description: string | null;
  /** Canonical directory, or null when the skill is declared but not installed. */
  path: string | null;
  scope: "project" | "user";
  /** Agent ids whose skill directory links this one. Empty means installed but
   *  wired to nothing — no agent can currently use it. */
  agents: string[];
  /** False when `skills-lock.json` declares it and the store hasn't got it —
   *  the state a fresh worktree is in. */
  installed: boolean;
  files: number;
  bytes: number;
  updatedAt: string | null;
  source: { source: string; ref: string | null; kind: string | null } | null;
}

export interface SkillsReport {
  /** Project root the skills were resolved against, or null outside a project. */
  root: string | null;
  skills: SkillRow[];
}

/** Skills available in a project, from one machine. Null when it can't answer —
 *  which the caller must not render as "this project has no skills". */
export async function fetchSkills(hostId: string, cwd: string): Promise<SkillsReport | null> {
  const cfg = await deviceForHost(hostId);
  if (!cfg) return null;
  try {
    return await get<SkillsReport>(cfg, `/v1/skills?cwd=${encodeURIComponent(cwd)}`, 20_000);
  } catch {
    return null;
  }
}

/** One slash command the agent really offers, as the composer renders it. */
export interface AgentCommand {
  /** Includes the leading slash, e.g. "/code-review". */
  cmd: string;
  desc: string;
  /** Argument hint the agent published, e.g. "[low|medium|high]". */
  hint?: string;
}

export interface CommandsReport {
  agent: string;
  cwd: string;
  /** Which transport enumerated the list — and therefore which one it is valid
   *  for. "acp" carries descriptions and argument hints; "cli" is names only.
   *  "static" means neither could answer and `commands` is empty, so the caller
   *  must keep its own fallback rather than render nothing. */
  source: "acp" | "cli" | "static";
  commands: AgentCommand[];
}

/**
 * The agent's real slash commands in a project. Null when the host can't answer.
 *
 * Both transports enumerate — ACP pushes `available_commands_update`, the CLI
 * carries the list on its `system`/`init` envelope — and the host answers for
 * whichever one this session will run on. The sets genuinely differ (`/clear`
 * runs under -p and is refused over ACP), which is why the caller must not
 * merge them or cache across a transport change.
 */
export async function fetchCommands(
  hostId: string,
  cwd: string,
  agent: string,
): Promise<CommandsReport | null> {
  const cfg = await deviceForHost(hostId);
  if (!cfg) return null;
  try {
    return await get<CommandsReport>(
      cfg,
      `/v1/commands?cwd=${encodeURIComponent(cwd)}&agent=${encodeURIComponent(agent)}`,
      20_000,
    );
  } catch {
    return null;
  }
}

/** One skill's SKILL.md. The host only serves a directory it just listed for
 *  this cwd, so an unknown path is a 404 rather than a file read. */
export async function fetchSkillDoc(
  hostId: string,
  cwd: string,
  dir: string,
): Promise<(SkillRow & { doc: string }) | null> {
  const cfg = await deviceForHost(hostId);
  if (!cfg) return null;
  try {
    return await get<SkillRow & { doc: string }>(
      cfg,
      `/v1/skill?cwd=${encodeURIComponent(cwd)}&dir=${encodeURIComponent(dir)}`,
      20_000,
    );
  } catch {
    return null;
  }
}

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
  const configs = await hostsToQuery();
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
  /** Only on the FIRST call, which spawns the PTY — the model is fixed for the
   *  life of that session, so follow-ups into an existing thread omit it. */
  model?: string | null,
): Promise<string | null> {
  const cfg = await deviceForHost(hostId);
  if (!cfg) return null;
  try {
    const res = await fetch(`${await bridgeBase(cfg)}/v1/session/interactive`, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
      body: JSON.stringify({ text, cwd, threadId, model }),
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
  const base = await bridgeBase(cfg);
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
        if (data.event) onEvent(withHostedMarkdownImages(data.event, base, cfg.token));
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
    `${base}/v1/turn/stream`,
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

/**
 * One machine, one row — for bridges that can't yet name themselves.
 *
 * `bridgeId` handles this properly now: identity comes from the bridge, so the
 * same machine at a second address is recognised at pairing time and never
 * becomes a second row. This remains for older bridges, which only expose a
 * machine-stable identity through the tunnel's nodeId — and only when a tunnel
 * has run at all, which is why loopback and emulator-alias pairings used to pile
 * up untouched.
 *
 * Duplicates are now MERGED rather than deleted. The old version called
 * forgetDevice, which took every thread synced under the stale address with it;
 * they belong to the machine you kept, so they move instead. Unreachable devices
 * are still never touched: a failed read is not authoritative — it may be a
 * different, sleeping machine.
 */
export async function forgetSameHostDuplicates(keepId: string): Promise<void> {
  const keep = await deviceForHost(keepId);
  if (!keep) return;
  const keepPairing = await fetchPairing(keep);
  if (!keepPairing?.nodeId) return;
  const stale: string[] = [];
  for (const d of (await listDeviceConfigs()).filter((d) => d.id !== keepId)) {
    // A device already identified by bridgeId was settled by adoption; only the
    // unidentified ones need this fallback.
    if (d.bridgeId) continue;
    const p = await fetchPairing(d);
    if (p?.nodeId && p.nodeId === keepPairing.nodeId) stale.push(d.id);
  }
  if (!stale.length) return;
  for (const id of stale) {
    await removeDeviceConfig(id);
    mergeDevice(id, keepId);
  }
  reconcileDevices((await listDeviceConfigs()).map((c) => c.id));
}

/** Add a device (a machine's bridge) and load all devices' live data. */
export async function connectBridge(cfg: BridgeConfig & Partial<DeviceExtras>): Promise<boolean> {
  connection$.status.set("connecting");
  const url = cfg.url.replace(/\/$/, "");
  // Only a brand-new pairing is rolled back on failure. An already-paired device
  // must survive a transient blip (bridge restart, cold daemon) — unpairing it
  // there would force a re-scan for what is really a momentary hiccup.
  // Matched on URL as well as id: with identity coming from the bridge, adding
  // an address for a machine you already have resolves to that EXISTING device,
  // which must never be torn down by a failure here.
  const urlId = deviceId(url);
  const wasPaired = (await listDeviceConfigs()).some((d) => d.id === urlId || d.url === url);
  // Roll back exactly what was added, not an id guessed from the URL — with
  // identity coming from the bridge, the stored id may be neither.
  let added: DeviceConfig | null = null;
  try {
    const { url: _u, token: _t, ...extras } = cfg;
    const dev = await addDeviceConfig(cfg.url, cfg.token, extras);
    added = dev;
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
        if (!p?.nodeId) return;
        // `/v1/pair` no longer discloses the tunnel secret to a network caller,
        // so this refresh carries a null token. Overwriting with it would throw
        // away the secret adopt issued us and silently kill off-LAN access —
        // keep whichever one we already hold for this same node.
        const raw = await SecureStore.getItemAsync(PAIRING_KEY);
        const held = raw ? (JSON.parse(raw) as PairPayload) : null;
        const token =
          p.token ?? (held?.nodeId === p.nodeId ? held.token : null) ?? dev.tunnelToken ?? null;
        await SecureStore.setItemAsync(PAIRING_KEY, JSON.stringify({ ...p, token }));
        // Stamp the identity on the device's own row as well — tunnelReach
        // prefers the row, so this machine keeps dialling ITSELF off-LAN even
        // after another machine's QR replaces the global pairing above. Never
        // for a grant: its row carries the per-grant tunnel, and the machine-
        // wide identity /v1/pair reports is one a guest cannot dial.
        if (!dev.grant) await stampDeviceTunnelIdentity(dev.id, p.nodeId, p.relay ?? null);
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
    if (!wasPaired && added) await removeDeviceConfig(added.id);
    connection$.status.set("disconnected");
    return false;
  }
}
