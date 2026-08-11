/**
 * Peer machines: finding them, asking them for access, and answering when they
 * ask us. The bridge-side halves are apps/bridge/agents/discovery.mjs and
 * agents/access.mjs; this is the client for both.
 *
 * TWO DIFFERENT CONVERSATIONS, and it matters which is which:
 *
 *   - With OUR OWN bridge, over loopback. Who is nearby, who is asking us for
 *     access, approve, deny, revoke. These are the owner's controls and the
 *     bridge refuses them from anywhere but this machine.
 *   - With a PEER's bridge, over the LAN, holding no credential at all. Only
 *     `/v1/access/request` and its poll accept that, and only because the
 *     request does nothing until a human at the other end approves it.
 *
 * The handshake runs in two steps because a peer cannot tick a space it has
 * never seen, and listing every repo name to a stranger on the network is
 * itself the leak: first a short PREVIEW grant good for nothing but a catalog
 * of names and dates, then a READ request built from what that turned up.
 */
import type { DeviceConfig } from "./bridge";
import { local, mine, minePost, post, req } from "./ownBridge";

// --- shapes -------------------------------------------------------------------

export interface Peer {
  readonly bridgeId: string;
  readonly hostName: string;
  readonly platform: string;
  readonly port: number;
  readonly version: string | null;
  readonly address: string;
  /** Where to knock: `http://<address>:<port>`. */
  readonly url: string;
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
}

export type Scope =
  | { kind: "full" }
  | { kind: "scoped"; repoKeys: string[]; threads: { agent: string; id: string }[] };

export interface AccessRequest {
  readonly id: string;
  readonly kind: "preview" | "read";
  readonly requester: {
    bridgeId: string;
    hostName: string;
    platform: string;
    appVersion: string | null;
  };
  readonly scope: Scope | null;
  readonly note: string | null;
  readonly previewGrant: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  /** Shown on both machines, so the approver knows whose laptop this is. */
  readonly code: string;
  readonly state: string;
  /**
   * Access this machine ALREADY granted the asker, or null for a stranger.
   *
   * Set by the bridge (agents/access.mjs), because only that side can see its
   * own grant list. It turns "someone wants in" into "someone you already
   * trust wants more", which is a different decision.
   */
  readonly existing?: { summary: string; expiresAt: string | null } | null;
}

export interface Grant {
  readonly id: string;
  readonly kind: "preview" | "read";
  readonly requester: AccessRequest["requester"];
  readonly scope: Scope | null;
  readonly summary: string;
  readonly issuedAt: string;
  readonly expiresAt: string | null;
  readonly lastUsedAt: string | null;
  readonly tunnel: { nodeId: string; relay: string | null } | null;
}

export interface CatalogSpace {
  readonly repoKey: string;
  readonly threadCount: number;
  readonly firstActivityAt: string | null;
  readonly lastActivityAt: string | null;
}

export interface CatalogThread {
  readonly id: string;
  readonly agent: string;
  readonly name: string | null;
  readonly repoKey: string;
  readonly createdAt: string | null;
  readonly lastActivityAt: string | null;
}

/** What a request POST hands back — `claim` is the capability that lets only
 *  the machine that asked poll for the answer. Keep it, or lose the request. */
export interface PendingAsk {
  readonly requestId: string;
  readonly claim: string;
  readonly code: string;
  /** The peer this was sent to, so a poll knows where to look. */
  readonly peerUrl: string;
}

// --- plumbing -----------------------------------------------------------------
// The loopback URL, the owner token and the timeout-bounded fetch are shared
// with every other owner-only feature — see services/ownBridge.ts.

/** Whether this machine announces itself, and whether that can be changed here.
 *  Announcing is opt-in: the beacon carries the machine's name. */
export interface DiscoveryState {
  readonly on: boolean;
  /** False on a bridge that may not announce at all (a non-default port). */
  readonly eligible: boolean;
  /** POUNCE_DISCOVERY decided it — show the state, not a control. */
  readonly locked: boolean;
  readonly chosen: boolean | null;
}

/** Machines announcing themselves on this network. Empty (rather than throwing)
 *  when the local bridge isn't up — "nobody nearby" is the honest render. */
export async function listPeers(): Promise<Peer[]> {
  return (await peerState()).peers;
}

/** The list AND the toggle, in one call — the screen needs both to say anything
 *  useful about an empty list. */
export async function peerState(): Promise<{ peers: Peer[]; discovery: DiscoveryState }> {
  const off: DiscoveryState = { on: false, eligible: false, locked: false, chosen: null };
  try {
    const r = await mine<{ peers: Peer[]; discovery: DiscoveryState }>("/v1/peers", {}, 4_000);
    return { peers: r.peers ?? [], discovery: r.discovery ?? off };
  } catch {
    return { peers: [], discovery: off };
  }
}

/** Start or stop announcing. Persisted by the bridge and applied at once. */
export async function setDiscoverable(enabled: boolean): Promise<DiscoveryState | null> {
  try {
    const r = await minePost<{ discovery: DiscoveryState }>("/v1/peers/discovery", { enabled });
    return r.discovery;
  } catch {
    return null;
  }
}

/** Who is asking US for access, and what we have already given out. */
export async function listAccess(): Promise<{ pending: AccessRequest[]; grants: Grant[] }> {
  try {
    return await mine<{ pending: AccessRequest[]; grants: Grant[] }>("/v1/access", {}, 4_000);
  } catch {
    return { pending: [], grants: [] };
  }
}

/**
 * Say yes.
 *
 * `scope` and `expiresAt` are the owner's decision and override whatever was
 * asked for — the request is a suggestion. A preview ignores both: it gets the
 * catalog and a few minutes, always.
 */
export function approveAccess(
  requestId: string,
  opts: { scope?: Scope; expiresAt?: string | null } = {},
): Promise<{ ok: boolean; grant: Grant }> {
  return minePost("/v1/access/approve", {
    requestId,
    scope: opts.scope,
    expiresAt: opts.expiresAt ?? null,
  });
}

export function denyAccess(requestId: string): Promise<{ ok: boolean }> {
  return minePost("/v1/access/deny", { requestId });
}

export function revokeGrant(grantId: string): Promise<{ ok: boolean }> {
  return minePost("/v1/access/revoke", { grantId });
}

/** OUR spaces and threads — what the approval sheet ticks against. The same
 *  projection a peer's preview sees, so the two ends agree on names and counts. */
export async function ownSpaces(): Promise<CatalogSpace[]> {
  try {
    const { spaces } = await mine<{ spaces: CatalogSpace[] }>("/v1/catalog/spaces", {}, 8_000);
    return spaces ?? [];
  } catch {
    return [];
  }
}

export async function ownThreads(q: string, space?: string): Promise<CatalogThread[]> {
  if (!q.trim()) return [];
  const params = new URLSearchParams({ q });
  if (space) params.set("space", space);
  try {
    const { threads } = await mine<{ threads: CatalogThread[] }>(
      `/v1/catalog/threads?${params}`,
      {},
      8_000,
    );
    return threads ?? [];
  } catch {
    return [];
  }
}

/** How we identify ourselves to a peer. Read from our own bridge so the id is
 *  the same one the peer's discovery beacon already saw. */
async function selfIdentity(): Promise<{
  bridgeId: string;
  hostName: string;
  platform: string;
  appVersion: string | null;
}> {
  const { status } = await mine<{
    status: { bridgeId?: string; device?: string; platform?: string; version?: string };
  }>("/v1/status", {}, 4_000);
  return {
    bridgeId: status?.bridgeId ?? "unknown",
    hostName: status?.device ?? "this machine",
    platform: status?.platform ?? "unknown",
    appVersion: status?.version ?? null,
  };
}

// --- asking a peer ---------------------------------------------------------------

/** Step one: ask to see what's there. Approved on the peer, briefly, and good
 *  for the catalog only. */
export async function requestPreview(peer: Peer, note?: string): Promise<PendingAsk> {
  const r = await post<{ requestId: string; claim: string; code: string }>(
    `${peer.url}/v1/access/request`,
    {
      kind: "preview",
      requester: await selfIdentity(),
      note,
    },
  );
  return { ...r, peerUrl: peer.url };
}

/** Step two: ask for read access to what the catalog turned up. */
export async function requestRead(
  peerUrl: string,
  scope: Scope,
  opts: { previewGrant?: string; note?: string; requestedHours?: number } = {},
): Promise<PendingAsk> {
  const r = await post<{ requestId: string; claim: string; code: string }>(
    `${peerUrl}/v1/access/request`,
    {
      kind: "read",
      requester: await selfIdentity(),
      scope,
      previewGrant: opts.previewGrant,
      note: opts.note,
      requestedHours: opts.requestedHours,
    },
  );
  return { ...r, peerUrl };
}

export interface AskResult {
  readonly state: "pending" | "approved" | "denied" | "revoked" | "expired";
  readonly token?: string;
  readonly grantId?: string;
  readonly kind?: "preview" | "read";
  readonly scope?: Scope | null;
  readonly expiresAt?: string | null;
  readonly bridge?: {
    id: string;
    hostName: string;
    url: string | null;
    nodeId: string | null;
    relay: string | null;
    tunnelToken?: string;
  };
}

/**
 * Has the other side answered yet?
 *
 * The token rides on the FIRST approved poll and is never sent again, so a
 * caller that drops it has to start over. Hold the result.
 */
export function pollAsk(ask: PendingAsk): Promise<AskResult> {
  return req<AskResult>(
    `${ask.peerUrl}/v1/access/request/${ask.requestId}?claim=${encodeURIComponent(ask.claim)}`,
    {},
    6_000,
  );
}

// --- reading a peer's catalog -----------------------------------------------------

export async function catalogSpaces(
  peerUrl: string,
  previewToken: string,
): Promise<CatalogSpace[]> {
  const { spaces } = await req<{ spaces: CatalogSpace[] }>(`${peerUrl}/v1/catalog/spaces`, {
    headers: { authorization: `Bearer ${previewToken}` },
  });
  return spaces ?? [];
}

/**
 * Search a peer's thread NAMES. `q` is required by the bridge on purpose — the
 * catalog is a lookup, not a dump — so an empty box returns nothing rather than
 * everything.
 */
export async function catalogThreads(
  peerUrl: string,
  previewToken: string,
  q: string,
  space?: string,
): Promise<CatalogThread[]> {
  if (!q.trim()) return [];
  const params = new URLSearchParams({ q });
  if (space) params.set("space", space);
  const { threads } = await req<{ threads: CatalogThread[] }>(
    `${peerUrl}/v1/catalog/threads?${params}`,
    { headers: { authorization: `Bearer ${previewToken}` } },
  );
  return threads ?? [];
}

// --- accepting a grant --------------------------------------------------------------

/**
 * Everything an approved grant needs to become a device: where to reach the
 * peer, and the terms the access was given on.
 *
 * This module deliberately does NOT call addDeviceConfig itself. It is the peer
 * PROTOCOL — plain HTTP — and reaching into the device store would drag
 * SecureStore, the collections and the notification layer in behind it. A
 * dynamic `import("./bridge")` looked like the way to have both, and it isn't:
 * Metro resolves a relative dynamic specifier against the CONSUMING app's root,
 * not this file's directory, so it failed at runtime with "unable to resolve
 * ./packages/app/src/services/bridge from desktop/" — after the one-shot token
 * had already been spent. The caller passes the result to addDeviceConfig using
 * its own package-qualified import, which resolves correctly everywhere.
 */
export function grantDevice(
  result: AskResult,
  fallbackUrl: string,
): {
  url: string;
  token: string;
  extras: Partial<Pick<DeviceConfig, "nodeId" | "relay" | "tunnelToken" | "grant">>;
} {
  if (!result.token) throw new Error("grant has no token to adopt");
  const url = result.bridge?.url || fallbackUrl;
  return {
    url,
    token: result.token,
    extras: {
      nodeId: result.bridge?.nodeId ?? undefined,
      relay: result.bridge?.relay ?? null,
      tunnelToken: result.bridge?.tunnelToken,
      grant: {
        id: result.grantId ?? "",
        scope: result.scope ?? null,
        summary: summarize(result.scope),
        expiresAt: result.expiresAt ?? null,
        issuedBy: result.bridge?.hostName ?? url,
      },
    },
  };
}

/** The same one-liner the approval sheet shows, for the device row. */
export function summarize(scope: Scope | null | undefined): string {
  if (!scope || scope.kind === "full") return "Everything";
  const bits: string[] = [];
  if (scope.repoKeys?.length) {
    bits.push(scope.repoKeys.length === 1 ? scope.repoKeys[0] : `${scope.repoKeys.length} spaces`);
  }
  if (scope.threads?.length) {
    bits.push(`${scope.threads.length} thread${scope.threads.length === 1 ? "" : "s"}`);
  }
  return bits.join(" + ") || "Nothing";
}

/** Durations the approval sheet offers. Absolute instants are computed at the
 *  moment of approval, so "1 day" means a day from the click. */
export const DURATIONS: { label: string; hours: number | null }[] = [
  { label: "1 hour", hours: 1 },
  { label: "8 hours", hours: 8 },
  { label: "1 day", hours: 24 },
  { label: "7 days", hours: 24 * 7 },
  { label: "No expiry", hours: null },
];

export function expiryFor(hours: number | null): string | null {
  return hours === null ? null : new Date(Date.now() + hours * 3_600_000).toISOString();
}

/** "3h left", "12m left", "expired" — the device row's clock. */
export function timeLeft(expiresAt: string | null | undefined): string {
  if (!expiresAt) return "no expiry";
  const ms = Date.parse(expiresAt) - Date.now();
  if (ms <= 0) return "expired";
  const mins = Math.round(ms / 60_000);
  // Never "0m left" — that reads as expired when it isn't, and the last minute
  // of a grant is exactly when someone might be looking at this.
  if (mins < 1) return "under a minute";
  if (mins < 60) return `${mins}m left`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h left`;
  return `${Math.round(hours / 24)}d left`;
}
