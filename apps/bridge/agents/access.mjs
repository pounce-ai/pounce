/**
 * Peer access: someone else's machine asking this one for a look at its threads.
 *
 * The bridge's own token (token.mjs) is all-or-nothing and forever — right for
 * the phone in your pocket, wrong for "let the Air read the pounce-mono threads
 * until tomorrow". This module is the second kind of credential: a GRANT, which
 * is read-only, narrowed to a scope, and stamped with an expiry.
 *
 * THE TWO-STEP HANDSHAKE, and why it exists. A peer cannot tick a space it has
 * never seen, but dumping the project list to any stranger on the café Wi-Fi is
 * itself the leak — repo names say plenty. So access is asked for twice:
 *
 *   1. `preview` — short (5 min default), and good for nothing but the catalog:
 *      space names with counts and dates, plus a thread-name SEARCH. No message
 *      content, no cwd, no branch, and threads must be searched for rather than
 *      listed, so a preview is a lookup and not a dump.
 *   2. `read` — built from what the preview turned up, scoped to those spaces
 *      and threads, and approved separately with a duration.
 *
 * Both steps end at a human on the owner's machine clicking Approve, which is
 * why the request route can be unauthenticated: the request is inert until then.
 * Each request carries a 6-digit VERIFICATION CODE shown on both machines, so
 * the person approving can tell their own laptop from someone else's.
 *
 * Tokens are stored hashed and compared with timingSafeEqual, the same
 * discipline token.mjs applies to the bridge's own credential, and the plaintext
 * is handed back exactly once — on the poll that first observes the approval.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { Store } from "./store.mjs";

/** A request nobody answers is abandoned, not pending forever. */
export const REQUEST_TTL_MS = 15 * 60_000;
/** Default life of a preview grant — long enough to browse, short enough that
 *  forgetting to revoke it costs nothing. */
export const PREVIEW_TTL_MS = 5 * 60_000;
/** Enough asks queued that a real user retrying isn't blocked; few enough that
 *  a hostile machine on the LAN can't paper the approval sheet. */
const MAX_PENDING = 5;
/** Minimum gap between requests from one address. */
const RATE_MS = 10_000;

/**
 * `device` is the odd one out and deliberately so.
 *
 * A grant is read-only by construction (see grantAllowsRoute — non-GET is
 * refused before any path is consulted), which is right for someone else's
 * laptop and useless for your own phone: a phone has to SEND messages, steer a
 * turn, stop one. That capability already has a credential — the bridge's own
 * token, all-or-nothing and forever, which is exactly what scanning the pairing
 * QR hands over.
 *
 * So a `device` request mints no grant at all. It reuses this handshake purely
 * as the consent gate — discover on the LAN, ask, a human approves — and the
 * approval hands back that same pairing token. Same access as the QR, reached
 * by tapping Approve instead of aiming a camera. Inventing a second, writable
 * grant kind would have been a parallel authorization system for a capability
 * that already has one.
 */
const KINDS = new Set(["preview", "read", "device"]);

const sha256 = (s) => createHash("sha256").update(s).digest();

/** Constant-time compare of two digests. Length-guarded because
 *  timingSafeEqual throws on a mismatch rather than returning false. */
function digestMatches(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function str(v, max) {
  return typeof v === "string" ? v.slice(0, max) : null;
}

/**
 * The code shown on both machines. Derived from the request id rather than
 * random so it needs no extra storage and the requester can compute its own
 * copy from what it was handed back.
 */
export function verificationCode(requestId) {
  const n = parseInt(
    createHash("sha256").update(`pounce-code:${requestId}`).digest("hex").slice(0, 8),
    16,
  );
  return String(n % 1_000_000).padStart(6, "0");
}

// --- scope --------------------------------------------------------------------

/**
 * A scope is either everything, or some set of spaces (repo keys) and/or
 * individual threads. Spaces are resolved against the LIVE thread list on every
 * request, not frozen at approval, so a thread started tomorrow in a granted
 * space is included — the space is the unit the owner agreed to, not a snapshot
 * of what was in it.
 *
 * Returns null for anything malformed; callers treat that as "no scope given".
 */
export function normalizeScope(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.kind === "full") return { kind: "full" };
  const repoKeys = Array.isArray(raw.repoKeys)
    ? [
        ...new Set(
          raw.repoKeys.filter((k) => typeof k === "string" && k).map((k) => k.slice(0, 256)),
        ),
      ]
    : [];
  const threads = Array.isArray(raw.threads)
    ? raw.threads
        .filter(
          (t) => t && typeof t.id === "string" && t.id && typeof t.agent === "string" && t.agent,
        )
        .map((t) => ({ agent: t.agent.slice(0, 32), id: t.id.slice(0, 256) }))
        .slice(0, 500)
    : [];
  if (!repoKeys.length && !threads.length) return null;
  return { kind: "scoped", repoKeys, threads };
}

/** One line for the approval sheet and the guest's device row. */
export function scopeSummary(scope) {
  if (!scope || scope.kind === "full") return "Everything";
  const bits = [];
  if (scope.repoKeys?.length) {
    bits.push(scope.repoKeys.length === 1 ? scope.repoKeys[0] : `${scope.repoKeys.length} spaces`);
  }
  if (scope.threads?.length) {
    bits.push(`${scope.threads.length} thread${scope.threads.length === 1 ? "" : "s"}`);
  }
  return bits.join(" + ") || "Nothing";
}

/**
 * Turn a scope into the sets the request filters actually check, given the
 * bridge's current thread list.
 *
 * `keys` are `agent:id` (what routes with both parameters can check exactly);
 * `ids` are bare thread ids, for the handful of places that only carry one.
 * `cwds` are the directories those threads live in, which is how file- and
 * git-shaped routes get scoped — they take a path, not a thread.
 */
export function resolveScope(scope, threads) {
  if (!scope || scope.kind === "full") return { full: true, keys: null, ids: null, cwds: null };
  const repoKeys = new Set(scope.repoKeys || []);
  const explicit = new Set((scope.threads || []).map((t) => `${t.agent}:${t.id}`));
  const keys = new Set();
  const ids = new Set();
  const cwds = new Set();
  for (const t of threads || []) {
    if (!repoKeys.has(t.repo) && !explicit.has(`${t.agent}:${t.id}`)) continue;
    keys.add(`${t.agent}:${t.id}`);
    ids.add(t.id);
    if (t.cwd) cwds.add(path.resolve(t.cwd));
    if (t.worktree) cwds.add(path.resolve(t.worktree));
  }
  return { full: false, keys, ids, cwds: [...cwds] };
}

/** Is `p` one of the allowed directories, or inside one? Resolved first so
 *  `..` can't walk a granted cwd out into the rest of the disk. */
export function pathInScope(resolved, p) {
  if (resolved.full) return true;
  if (!p) return false;
  const target = path.resolve(p);
  return resolved.cwds.some((c) => target === c || target.startsWith(c + path.sep));
}

// --- what a grant may call ----------------------------------------------------

/**
 * A grant reaches an ALLOWLIST, never a denylist. Every route added to
 * server.mjs later is therefore closed to guests until someone deliberately
 * opens it — the failure direction that doesn't leak.
 *
 * Left out on purpose, though they are reads: /v1/token and /v1/pair hand over
 * credentials, /v1/config and /v1/doctor expose the machine's setup and
 * environment, /v1/dirs and /v1/files browse the filesystem with no thread to
 * scope them to, /v1/peers and /v1/access are the owner's own controls.
 */
/**
 * Names and dates, nothing else. Reachable by a PREVIEW grant, which is what
 * that kind of grant exists for — and now also by a live READ grant, so a
 * machine you have already approved can see what else is here and ask for it.
 *
 * That second half is a deliberate widening and worth naming: a peer scoped to
 * one space can list the NAMES of all of them. The alternative was making an
 * already-connected machine re-run the whole stranger handshake — a second
 * approval click for a machine you approved yesterday — to ask for one more
 * space, which is the kind of friction that trains people to click yes without
 * reading. What is bounded here is what a preview would have shown them anyway
 * had they asked: names and dates, never a message, and `/v1/catalog/threads`
 * still refuses to dump without a query. The owner approves the new scope, and
 * revoking still ends it.
 */
const CATALOG_ROUTES = ["/v1/catalog/spaces", "/v1/catalog/threads"];

const PREVIEW_ROUTES = new Set([...CATALOG_ROUTES, "/v1/status"]);

const READ_ROUTES = new Set([
  ...CATALOG_ROUTES,
  "/v1/status",
  "/v1/agents",
  "/v1/threads",
  "/v1/threads/stream",
  "/v1/messages",
  "/v1/image",
  "/v1/trajectory",
  "/v1/search",
  "/v1/activity",
  "/v1/usage",
  "/v1/models",
  "/v1/context",
  "/v1/git/changes",
  "/v1/git/checks",
  "/v1/skills",
  "/v1/skill",
  "/v1/file",
  "/v1/markers",
]);

/**
 * Machine-wide aggregates with no thread to narrow them to. A partial grant is
 * a statement about some threads, not a licence to read the whole account's
 * spend, so these need the full scope.
 *
 * /v1/activity is here rather than filtered because it returns a daily SERIES —
 * totals already summed across every thread on the host. There is no per-thread
 * row left to drop, so "filtering" it would be a fiction.
 */
const FULL_ONLY_ROUTES = new Set(["/v1/quota", "/v1/activity", "/v1/disk"]);

export function grantAllowsRoute(grant, method, pathname) {
  // Read-only is enforced by the verb as well as the path: several allowed
  // routes (/v1/context, /v1/markers) have a POST twin that writes.
  if (method !== "GET" && method !== "HEAD") return false;
  if (grant.kind === "preview") return PREVIEW_ROUTES.has(pathname);
  if (FULL_ONLY_ROUTES.has(pathname)) return grant.scope?.kind === "full";
  return READ_ROUTES.has(pathname);
}

// --- the store ----------------------------------------------------------------

/**
 * @param {{ store?: Store, now?: () => number }} [opts] test seams
 */
export function createAccess({ store = new Store("access"), now = () => Date.now() } = {}) {
  /** ip -> last request time. In memory: a rate limit that survives restarts
   *  would let a reboot loop be used to lock the owner out of their own asks. */
  const lastByIp = new Map();

  const requests = () => Object.values(store.withPrefix("req:"));
  const allGrants = () => Object.values(store.withPrefix("grant:"));
  const grants = () => allGrants().filter((g) => !g.endedAt);

  /**
   * Retire a grant, leaving a TOMBSTONE rather than deleting the row.
   *
   * Deleting it would be tidier and is wrong: the guest's next request would
   * then get a bare 401, indistinguishable from a typo'd token, and its only
   * safe reading of that is "maybe I'm misconfigured" — so a revoked machine
   * sits in its device list forever showing stale threads. Keeping the hash
   * lets us answer "this ended, and here is why", which is what lets the other
   * side drop the device and its rows. Scope and the tunnel secret go now; only
   * the hash and the reason need to survive.
   */
  const end = (g, reason) => {
    store.set(`grant:${g.id}`, {
      ...g,
      scope: null,
      tunnelSecret: null,
      tunnel: null,
      endedAt: now(),
      endedReason: reason,
    });
  };

  /** How long a tombstone is kept. Long past any plausible "my laptop was shut"
   *  gap, so the guest is told properly rather than left guessing. */
  const TOMBSTONE_MS = 30 * 86_400_000;

  const pending = () =>
    requests().filter((r) => r.state === "pending" && now() - r.createdAt < REQUEST_TTL_MS);

  /** Public shape of a request — never the claim hash. */
  /**
   * Access this asker ALREADY holds, if any — the difference between "a machine
   * you have never heard of wants in" and "a machine you already trust wants one
   * more space". Those are different decisions and the approver cannot make the
   * second one safely while being shown the first.
   *
   * A preview is excluded on purpose: it is the scaffolding of an in-flight
   * first-time ask, so counting it as "already connected" would label every
   * stranger a returning one halfway through their own handshake.
   */
  const existingAccess = (r) => {
    const g = grants().find(
      (x) => x.kind === "read" && x.requester?.bridgeId === r.requester?.bridgeId,
    );
    if (!g) return null;
    return {
      summary: scopeSummary(g.scope),
      expiresAt: g.expiresAt ? new Date(g.expiresAt).toISOString() : null,
    };
  };

  const publicRequest = (r) => ({
    id: r.id,
    kind: r.kind,
    requester: r.requester,
    scope: r.scope,
    note: r.note,
    previewGrant: r.previewGrant,
    requestedHours: r.requestedHours,
    createdAt: new Date(r.createdAt).toISOString(),
    expiresAt: new Date(r.createdAt + REQUEST_TTL_MS).toISOString(),
    code: verificationCode(r.id),
    state: r.state,
    existing: existingAccess(r),
  });

  /** Public shape of a grant — never the token hash. */
  const publicGrant = (g) => ({
    id: g.id,
    kind: g.kind,
    requester: g.requester,
    scope: g.scope,
    // A preview carries no scope, and running that through scopeSummary said
    // "Everything" — the one word it must never say about a grant that can read
    // nothing but names. Answered by kind before scope is consulted.
    summary: g.kind === "preview" ? "Names and dates only" : scopeSummary(g.scope),
    issuedAt: new Date(g.issuedAt).toISOString(),
    expiresAt: g.expiresAt ? new Date(g.expiresAt).toISOString() : null,
    lastUsedAt: g.lastUsedAt ? new Date(g.lastUsedAt).toISOString() : null,
    tunnel: g.tunnel ?? null,
  });

  const api = {
    /**
     * Record an ask. Deliberately does nothing else — no token exists until a
     * human approves, so the worst an unauthenticated caller achieves is a
     * prompt on someone's screen.
     */
    submit({ kind, requester, scope, note, previewGrant, requestedHours, ip }) {
      if (!KINDS.has(kind)) return { ok: false, error: "bad kind" };
      const bridgeId = str(requester?.bridgeId, 64);
      if (!bridgeId) return { ok: false, error: "requester.bridgeId required" };

      // The rate limit is there to stop an unapproved stranger papering the
      // approval sheet. It must NOT catch the second half of the handshake:
      // preview then read is two requests from one address seconds apart, by
      // design, and the read only exists because a human already said yes to
      // the preview. Exempt exactly that — a read naming a live preview grant
      // issued to this same machine, which nobody can forge without holding it.
      const continues =
        kind === "read" &&
        previewGrant &&
        grants().some((g) => g.id === previewGrant && g.requester?.bridgeId === bridgeId);
      const last = lastByIp.get(ip);
      if (!continues && last && now() - last < RATE_MS) {
        return { ok: false, error: "too many requests", retryAfterMs: RATE_MS - (now() - last) };
      }

      // One live ask per peer per kind: a machine retrying because the user
      // walked away should replace its own request, not stack another card on
      // the approval sheet.
      for (const r of pending()) {
        if (r.requester?.bridgeId === bridgeId && r.kind === kind) store.delete(`req:${r.id}`);
      }
      if (pending().length >= MAX_PENDING) return { ok: false, error: "too many pending requests" };

      const id = randomBytes(16).toString("hex");
      const claim = randomBytes(32).toString("hex");
      store.set(`req:${id}`, {
        id,
        kind,
        // The claim is what proves "I am the machine that asked" when polling.
        // Hashed like any other credential.
        claimHash: sha256(claim).toString("hex"),
        requester: {
          bridgeId,
          hostName: str(requester?.hostName, 64) || "unknown machine",
          platform: str(requester?.platform, 16) || "unknown",
          appVersion: str(requester?.appVersion, 32),
          nodeId: str(requester?.nodeId, 128),
          relay: str(requester?.relay, 256),
        },
        scope: kind === "read" ? normalizeScope(scope) : null,
        note: str(note, 280),
        previewGrant: str(previewGrant, 64),
        requestedHours: Number.isFinite(requestedHours) ? Math.max(0, requestedHours) : null,
        createdAt: now(),
        state: "pending",
      });
      lastByIp.set(ip, now());
      return { ok: true, requestId: id, claim, code: verificationCode(id) };
    },

    /**
     * The requester's poll. The token rides on the FIRST approved read and is
     * then dropped from storage — a replayed poll gets the state without the
     * credential, so an intercepted claim after the fact buys nothing.
     */
    poll(id, claim) {
      const r = store.get(`req:${id}`);
      if (!r) return { ok: false, error: "unknown request" };
      if (!digestMatches(sha256(String(claim ?? "")), Buffer.from(r.claimHash, "hex"))) {
        return { ok: false, error: "unknown request" };
      }
      if (r.state === "pending" && now() - r.createdAt >= REQUEST_TTL_MS) {
        store.delete(`req:${id}`);
        return { ok: true, state: "expired" };
      }
      if (r.state !== "approved") return { ok: true, state: r.state };

      // A device approval carries the bridge's own token and mints no grant, so
      // there is nothing to look up — and nothing to expire.
      if (r.kind === "device") {
        const out = { ok: true, state: "approved", kind: "device", bridge: r.bridge };
        if (r.token) {
          out.token = r.token;
          store.set(`req:${id}`, { ...r, token: null, deliveredAt: now() });
        }
        return out;
      }

      const g = store.get(`grant:${r.grantId}`);
      if (!g) return { ok: true, state: "revoked" };
      const out = {
        ok: true,
        state: "approved",
        grantId: g.id,
        kind: g.kind,
        scope: g.scope,
        expiresAt: g.expiresAt ? new Date(g.expiresAt).toISOString() : null,
        bridge: r.bridge,
      };
      if (r.token) {
        out.token = r.token;
        store.set(`req:${id}`, { ...r, token: null, deliveredAt: now() });
      }
      return out;
    },

    /**
     * Mint the grant. The owner's scope and duration win outright over whatever
     * was asked for — the request is a suggestion, the approval is the decision.
     *
     * `bridge` is how the guest reaches us afterwards (url, and the per-grant
     * tunnel identity when one was started), carried back on its next poll.
     */
    approve(requestId, { scope, expiresAt, bridge, deviceToken } = {}) {
      const r = store.get(`req:${requestId}`);
      if (!r || r.state !== "pending") return { ok: false, error: "unknown request" };

      // Approving a DEVICE hands over the bridge's own pairing token — the
      // caller supplies it, because this module deliberately doesn't hold it.
      // No grant, no scope, no expiry: the phone becomes a paired device, and
      // un-pairing it is removing the device, not revoking a grant.
      if (r.kind === "device") {
        if (!deviceToken) return { ok: false, error: "deviceToken required" };
        // Remembered so "Shared access" can list the phones holding this
        // machine's token. It is a RECORD, not a credential: the token is the
        // machine's own, so this row cannot be revoked on its own — see
        // listDevices().
        store.set(`device:${r.requester.bridgeId}`, {
          bridgeId: r.requester.bridgeId,
          hostName: r.requester.hostName,
          platform: r.requester.platform,
          pairedAt: now(),
        });
        store.set(`req:${requestId}`, {
          ...r,
          state: "approved",
          grantId: null,
          token: deviceToken, // held only until the requester's next poll collects it
          bridge: bridge ?? null,
        });
        return { ok: true, device: true };
      }

      const isPreview = r.kind === "preview";
      const finalScope = isPreview ? null : (normalizeScope(scope) ?? r.scope ?? { kind: "full" });
      const expiry = isPreview ? now() + PREVIEW_TTL_MS : expiresAt ? Date.parse(expiresAt) : null;
      if (expiry !== null && !Number.isFinite(expiry)) return { ok: false, error: "bad expiresAt" };

      const token = randomBytes(32).toString("hex");
      const id = randomBytes(16).toString("hex");
      store.set(`grant:${id}`, {
        id,
        kind: r.kind,
        tokenHash: sha256(token).toString("hex"),
        // The off-LAN tunnel needs a shared secret for its QUIC handshake, and
        // the bridge has to be able to reproduce it after a restart to bring the
        // tunnel back up — so unlike the grant token it is stored in the clear.
        // Safe to: it gates a byte pipe, not the data. Anyone who steals it
        // reaches this bridge's front door and is then 401'd like anyone else.
        tunnelSecret: randomBytes(32).toString("hex"),
        requester: r.requester,
        scope: finalScope,
        issuedAt: now(),
        expiresAt: expiry,
        lastUsedAt: null,
        tunnel: null,
      });
      store.set(`req:${requestId}`, {
        ...r,
        state: "approved",
        grantId: id,
        token, // held only until the requester's next poll collects it
        bridge: bridge ?? null,
      });

      // A preview has done its job once read access is granted off the back of
      // it; leaving it live would quietly outlast the step it belonged to.
      if (!isPreview && r.previewGrant) api.revoke(r.previewGrant);

      return { ok: true, grant: publicGrant(store.get(`grant:${id}`)), token };
    },

    deny(requestId) {
      const r = store.get(`req:${requestId}`);
      if (!r) return { ok: false, error: "unknown request" };
      store.set(`req:${requestId}`, { ...r, state: "denied", token: null });
      return { ok: true };
    },

    /** Returns the ended grant so the caller can tear down its tunnel. */
    revoke(grantId) {
      const g = store.get(`grant:${grantId}`);
      if (!g || g.endedAt) return { ok: false, error: "unknown grant" };
      end(g, "grant_revoked");
      for (const r of requests()) {
        if (r.grantId === grantId)
          store.set(`req:${r.id}`, { ...r, state: "revoked", token: null });
      }
      return { ok: true, grant: publicGrant(g) };
    },

    /** The QUIC handshake secret for this grant's tunnel, so it can be brought
     *  back up after a restart. Never leaves via listGrants(). */
    tunnelSecret(grantId) {
      return store.get(`grant:${grantId}`)?.tunnelSecret ?? null;
    },

    /** Record the tunnel identity started for a grant, so the guest's poll can
     *  carry it and revocation knows there is a process to kill. */
    setTunnel(grantId, tunnel) {
      const g = store.get(`grant:${grantId}`);
      if (!g) return;
      store.set(`grant:${grantId}`, { ...g, tunnel: tunnel ?? null });
      const reach = tunnel ? { ...tunnel, tunnelToken: g.tunnelSecret } : null;
      for (const r of requests()) {
        if (r.grantId === grantId && r.bridge) {
          store.set(`req:${r.id}`, { ...r, bridge: { ...r.bridge, ...reach } });
        }
      }
    },

    /**
     * Resolve a presented bearer token to its grant.
     *
     * Returns `{ ended: true, reason, grant }` rather than null for a grant that
     * has lapsed or been revoked, so the HTTP layer can say which — that named
     * answer is what lets the guest drop the device and its rows instead of
     * showing the machine as merely offline forever.
     */
    forToken(token) {
      if (typeof token !== "string" || !token) return null;
      const digest = sha256(token);
      for (const g of allGrants()) {
        if (!digestMatches(digest, Buffer.from(g.tokenHash, "hex"))) continue;
        if (g.endedAt) return { ended: true, reason: g.endedReason, grant: publicGrant(g) };
        if (g.expiresAt !== null && now() >= g.expiresAt) {
          end(g, "grant_expired");
          return { ended: true, reason: "grant_expired", grant: publicGrant(g) };
        }
        return { ended: false, grant: g };
      }
      return null;
    },

    /** Stamped on each accepted request — "last active" in the owner's list. */
    touch(grantId) {
      const g = store.get(`grant:${grantId}`);
      if (g) store.set(`grant:${grantId}`, { ...g, lastUsedAt: now() });
    },

    /** Drop lapsed grants and abandoned requests. Returns the grants that went,
     *  so their tunnels can be reaped. */
    sweep() {
      const dropped = [];
      for (const g of allGrants()) {
        if (g.endedAt) {
          // Tombstones age out long after anyone could still be asking.
          if (now() - g.endedAt >= TOMBSTONE_MS) store.delete(`grant:${g.id}`);
          continue;
        }
        if (g.expiresAt !== null && now() >= g.expiresAt) {
          end(g, "grant_expired");
          dropped.push(publicGrant(g));
        }
      }
      for (const r of requests()) {
        const age = now() - r.createdAt;
        // Approved requests are kept a while past the ask's own TTL: the grant
        // outlives it, and the guest may poll late to collect its token.
        const ttl = r.state === "pending" ? REQUEST_TTL_MS : REQUEST_TTL_MS * 4;
        if (age >= ttl) store.delete(`req:${r.id}`);
      }
      return dropped;
    },

    // --- the other direction: what WE asked other machines for ------------------
    // Only the desktop app used to track this, which made the whole feature
    // macOS-only in practice. The bridge holds it instead, so a Windows or Linux
    // box — or an SSH session with no browser at all — can run the same handshake
    // through /peers or the CLI.

    /** Remember an ask we sent, with the claim needed to collect its answer. */
    rememberAsk(peerUrl, ask) {
      store.set(`ask:${ask.requestId}`, {
        id: ask.requestId,
        peerUrl,
        claim: ask.claim,
        code: ask.code,
        kind: ask.kind,
        createdAt: now(),
      });
      return ask;
    },

    getAsk(requestId) {
      return store.get(`ask:${requestId}`) ?? null;
    },

    forgetAsk(requestId) {
      store.delete(`ask:${requestId}`);
    },

    /**
     * Record access a peer granted US.
     *
     * Keyed by the peer's bridgeId so re-granting the same machine replaces its
     * terms rather than stacking a second row — the same reasoning resolvePairing
     * applies on the app side.
     */
    saveHeld(peer) {
      const id = peer.bridgeId || peer.url;
      store.set(`held:${id}`, { ...peer, id, savedAt: now() });
      return store.get(`held:${id}`);
    },

    /** Access we hold on other machines, expired ones dropped as we go. */
    listHeld() {
      const out = [];
      for (const [key, h] of Object.entries(store.withPrefix("held:"))) {
        if (h.expiresAt && Date.parse(h.expiresAt) <= now()) {
          store.delete(key);
          continue;
        }
        out.push(h);
      }
      return out.sort((a, b) => b.savedAt - a.savedAt);
    },

    forgetHeld(id) {
      return store.delete(`held:${id}`);
    },

    /** The live grant we hold on a peer, found by its URL — so callers can name
     *  the machine instead of carrying its token around. */
    heldFor(peerUrl) {
      const want = String(peerUrl || "").replace(/\/$/, "");
      return api.listHeld().find((h) => String(h.url || "").replace(/\/$/, "") === want) ?? null;
    },

    listPending() {
      return pending()
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(publicRequest);
    },

    /**
     * Phones and tablets paired through a `device` ask.
     *
     * Listed separately from grants because they are a different thing: a grant
     * is read-only, scoped and revocable on its own, while a paired device
     * holds this machine's pairing token — the same credential the QR hands
     * out. Un-pairing one means rotating that token, which ends every device.
     * Showing them here at least answers "what has access?" honestly.
     */
    listDevices() {
      return Object.values(store.withPrefix("device:")).map((d) => ({
        ...d,
        pairedAt: new Date(d.pairedAt).toISOString(),
      }));
    },

    listGrants() {
      return grants()
        .sort((a, b) => b.issuedAt - a.issuedAt)
        .map(publicGrant);
    },

    /** Live grants that have a tunnel to keep running. */
    tunnelledGrants() {
      return grants().map(publicGrant);
    },
  };

  return api;
}
