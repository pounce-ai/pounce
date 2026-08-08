/**
 * Peer access grants.
 *
 * These pin the properties that make an unauthenticated request route safe to
 * expose: a request does nothing until a human approves it, the owner's scope
 * beats the requester's, a grant reaches an allowlist and only within its scope,
 * and it stops working the moment it lapses.
 */
import { describe, expect, it, beforeEach } from "vitest";
import {
  createAccess,
  grantAllowsRoute,
  normalizeScope,
  pathInScope,
  resolveScope,
  scopeSummary,
  verificationCode,
  PREVIEW_TTL_MS,
  REQUEST_TTL_MS,
} from "./access.mjs";

/** Store's surface, in memory — the real one writes to ~/.pounce/state. */
function memStore() {
  const rows = new Map();
  return {
    rows,
    get: (k) => rows.get(k),
    has: (k) => rows.has(k),
    set: (k, v) => rows.set(k, v),
    delete: (k) => rows.delete(k),
    all: () => Object.fromEntries(rows),
    withPrefix: (p) => Object.fromEntries([...rows].filter(([k]) => k.startsWith(p))),
  };
}

let clock;
let access;
const at = (ms) => {
  clock = ms;
};

beforeEach(() => {
  clock = 1_000_000;
  access = createAccess({ store: memStore(), now: () => clock });
});

const REQUESTER = { bridgeId: "air-1", hostName: "macbook-air", platform: "darwin" };
const ask = (over = {}) =>
  access.submit({ kind: "read", requester: REQUESTER, ip: "192.168.1.9", ...over });

describe("requests", () => {
  it("records an ask but mints nothing until a human approves", () => {
    const r = ask();
    expect(r.ok).toBe(true);
    expect(r.requestId).toMatch(/^[0-9a-f]{32}$/);
    expect(r.claim).toMatch(/^[0-9a-f]{64}$/);
    // Nothing to authenticate with yet — that is what makes the route safe.
    expect(access.listGrants()).toEqual([]);
    expect(access.poll(r.requestId, r.claim)).toMatchObject({ state: "pending" });
  });

  it("shows the same verification code on both machines", () => {
    const r = ask();
    expect(r.code).toMatch(/^\d{6}$/);
    expect(access.listPending()[0].code).toBe(r.code);
    expect(verificationCode(r.requestId)).toBe(r.code);
  });

  it("refuses to be polled without the claim", () => {
    const r = ask();
    expect(access.poll(r.requestId, "not-the-claim")).toMatchObject({ ok: false });
    expect(access.poll(r.requestId, "")).toMatchObject({ ok: false });
  });

  it("rate-limits one address", () => {
    expect(ask().ok).toBe(true);
    const second = access.submit({
      kind: "preview",
      requester: { ...REQUESTER, bridgeId: "air-2" },
      ip: "192.168.1.9",
    });
    expect(second.ok).toBe(false);
    expect(second.retryAfterMs).toBeGreaterThan(0);
    at(clock + 10_001);
    expect(
      access.submit({
        kind: "preview",
        requester: { ...REQUESTER, bridgeId: "air-2" },
        ip: "192.168.1.9",
      }).ok,
    ).toBe(true);
  });

  it("does not rate-limit the read that follows an approved preview", () => {
    // The handshake is two asks from one address seconds apart, by design. If
    // the limiter caught the second, the feature could never complete.
    const p = access.submit({ kind: "preview", requester: REQUESTER, ip: "192.168.1.9" });
    const { grant } = access.approve(p.requestId, {});
    const read = ask({ previewGrant: grant.id, scope: { repoKeys: ["x"] } });
    expect(read.ok).toBe(true);
  });

  it("still rate-limits a read waving an id it was never given", () => {
    ask();
    const forged = access.submit({
      kind: "read",
      requester: REQUESTER,
      ip: "192.168.1.9",
      previewGrant: "not-a-real-grant",
      scope: { repoKeys: ["x"] },
    });
    expect(forged.ok).toBe(false);
  });

  it("replaces a peer's own pending ask rather than stacking cards", () => {
    const first = ask();
    at(clock + 20_000);
    const second = ask();
    expect(access.listPending()).toHaveLength(1);
    expect(access.listPending()[0].id).toBe(second.requestId);
    expect(access.poll(first.requestId, first.claim)).toMatchObject({ ok: false });
  });

  it("caps how many different peers can be queued at once", () => {
    for (let i = 0; i < 8; i++) {
      at(clock + 11_000);
      access.submit({
        kind: "read",
        requester: { ...REQUESTER, bridgeId: `peer-${i}` },
        ip: `10.0.0.${i}`,
      });
    }
    expect(access.listPending().length).toBeLessThanOrEqual(5);
  });

  it("abandons a request nobody answers", () => {
    const r = ask();
    at(clock + REQUEST_TTL_MS + 1);
    expect(access.listPending()).toEqual([]);
    expect(access.poll(r.requestId, r.claim)).toMatchObject({ state: "expired" });
  });
});

describe("approval", () => {
  it("hands the token over exactly once", () => {
    const r = ask();
    access.approve(r.requestId, {
      scope: { kind: "full" },
      expiresAt: new Date(clock + 3600_000).toISOString(),
    });

    const first = access.poll(r.requestId, r.claim);
    expect(first.state).toBe("approved");
    expect(first.token).toMatch(/^[0-9a-f]{64}$/);

    // A replayed poll gets the state but never the credential again.
    const second = access.poll(r.requestId, r.claim);
    expect(second.state).toBe("approved");
    expect(second.token).toBeUndefined();
  });

  it("lets the owner's scope beat the one that was asked for", () => {
    const r = ask({ scope: { kind: "full" } });
    access.approve(r.requestId, { scope: { repoKeys: ["pounce-mono"] } });
    const [g] = access.listGrants();
    expect(g.scope).toEqual({ kind: "scoped", repoKeys: ["pounce-mono"], threads: [] });
    expect(g.summary).toBe("pounce-mono");
  });

  it("never stores the token in the clear on the grant", () => {
    const r = ask();
    const { token } = access.approve(r.requestId, { scope: { kind: "full" } });
    expect(JSON.stringify(access.listGrants())).not.toContain(token);
  });

  it("never describes a preview as 'Everything'", () => {
    // It carries no scope, and a bare scopeSummary(null) says "Everything" —
    // the one word that must never describe a grant limited to names.
    const p = access.submit({ kind: "preview", requester: REQUESTER, ip: "1.2.3.4" });
    const { grant } = access.approve(p.requestId, {});
    expect(grant.summary).toBe("Names and dates only");
  });

  it("gives a preview its own short life regardless of what was requested", () => {
    const r = access.submit({
      kind: "preview",
      requester: REQUESTER,
      ip: "1.2.3.4",
      requestedHours: 720,
    });
    access.approve(r.requestId, { expiresAt: new Date(clock + 999_000_000).toISOString() });
    const [g] = access.listGrants();
    expect(Date.parse(g.expiresAt)).toBe(clock + PREVIEW_TTL_MS);
  });

  it("retires the preview when read access is granted off the back of it", () => {
    const p = access.submit({ kind: "preview", requester: REQUESTER, ip: "1.2.3.4" });
    const preview = access.approve(p.requestId, {});
    at(clock + 11_000);
    const r = ask({ previewGrant: preview.grant.id });
    access.approve(r.requestId, { scope: { kind: "full" } });

    expect(access.forToken(preview.token)).toMatchObject({ ended: true, reason: "grant_revoked" });
    expect(access.listGrants()).toHaveLength(1);
  });

  it("denies without minting anything", () => {
    const r = ask();
    expect(access.deny(r.requestId).ok).toBe(true);
    expect(access.listGrants()).toEqual([]);
    expect(access.poll(r.requestId, r.claim)).toMatchObject({ state: "denied" });
  });
});

describe("token resolution and expiry", () => {
  const grantFor = (expiresAt, scope = { kind: "full" }) => {
    const r = ask();
    return access.approve(r.requestId, { scope, expiresAt });
  };

  it("resolves a live grant and refuses an unknown token", () => {
    const { token } = grantFor(new Date(clock + 3600_000).toISOString());
    expect(access.forToken(token)).toMatchObject({ ended: false });
    expect(access.forToken("0".repeat(64))).toBeNull();
    expect(access.forToken("")).toBeNull();
    expect(access.forToken(undefined)).toBeNull();
  });

  it("reports expiry distinctly, and keeps saying so", () => {
    const { token } = grantFor(new Date(clock + 60_000).toISOString());
    at(clock + 60_001);
    expect(access.forToken(token)).toMatchObject({ ended: true, reason: "grant_expired" });
    // The answer has to stay legible on every later request, or the guest's
    // only reading of a bare 401 is "maybe I'm misconfigured" — and the machine
    // sits in its list forever showing threads it no longer has.
    expect(access.forToken(token)).toMatchObject({ ended: true, reason: "grant_expired" });
    expect(access.listGrants()).toEqual([]);
  });

  it("drops the scope and the tunnel secret when a grant ends", () => {
    const { token, grant } = grantFor(null);
    access.revoke(grant.id);
    expect(access.tunnelSecret(grant.id)).toBeNull();
    expect(access.forToken(token).grant.scope).toBeNull();
  });

  it("forgets a tombstone long after anyone could still be asking", () => {
    const { token } = grantFor(new Date(clock + 60_000).toISOString());
    at(clock + 60_001);
    access.sweep();
    at(clock + 31 * 86_400_000);
    access.sweep();
    expect(access.forToken(token)).toBeNull();
  });

  it("honours a grant with no expiry", () => {
    const { token } = grantFor(null);
    at(clock + 365 * 86_400_000);
    expect(access.forToken(token)).toMatchObject({ ended: false });
  });

  it("sweeps lapsed grants and reports them for teardown", () => {
    const a = grantFor(new Date(clock + 60_000).toISOString());
    at(clock + 11_000);
    const b = grantFor(null);
    at(clock + 60_001);
    const dropped = access.sweep();
    expect(dropped.map((g) => g.id)).toEqual([a.grant.id]);
    expect(access.listGrants().map((g) => g.id)).toEqual([b.grant.id]);
  });

  it("stops working the moment it is revoked, and says which ending it was", () => {
    const { token, grant } = grantFor(null);
    access.revoke(grant.id);
    expect(access.forToken(token)).toMatchObject({ ended: true, reason: "grant_revoked" });
    expect(access.listGrants()).toEqual([]);
    expect(access.revoke(grant.id).ok).toBe(false); // not twice
  });
});

describe("scope", () => {
  const THREADS = [
    { id: "t1", agent: "claude", repo: "pounce-mono", cwd: "/w/pounce", worktree: null },
    { id: "t2", agent: "claude", repo: "pounce-mono", cwd: "/w/pounce", worktree: "/w/pounce-wt" },
    { id: "t3", agent: "codex", repo: "client-work", cwd: "/w/client", worktree: null },
    { id: "t4", agent: "claude", repo: "dotfiles", cwd: "/w/dotfiles", worktree: null },
  ];

  it("rejects an empty or malformed scope", () => {
    expect(normalizeScope(null)).toBeNull();
    expect(normalizeScope({})).toBeNull();
    expect(normalizeScope({ repoKeys: [], threads: [] })).toBeNull();
    expect(normalizeScope({ threads: [{ id: "t1" }] })).toBeNull(); // no agent
  });

  it("passes everything through for a full scope", () => {
    const r = resolveScope({ kind: "full" }, THREADS);
    expect(r.full).toBe(true);
    expect(pathInScope(r, "/anywhere/at/all")).toBe(true);
  });

  it("resolves a space to its threads and their directories", () => {
    const r = resolveScope(normalizeScope({ repoKeys: ["pounce-mono"] }), THREADS);
    expect([...r.ids].sort()).toEqual(["t1", "t2"]);
    expect([...r.keys].sort()).toEqual(["claude:t1", "claude:t2"]);
    expect(r.cwds.sort()).toEqual(["/w/pounce", "/w/pounce-wt"]);
  });

  it("resolves loose threads alongside spaces", () => {
    const r = resolveScope(
      normalizeScope({ repoKeys: ["dotfiles"], threads: [{ agent: "codex", id: "t3" }] }),
      THREADS,
    );
    expect([...r.ids].sort()).toEqual(["t3", "t4"]);
  });

  it("includes a thread that appears in a granted space later", () => {
    const scope = normalizeScope({ repoKeys: ["pounce-mono"] });
    const later = [
      ...THREADS,
      { id: "t5", agent: "claude", repo: "pounce-mono", cwd: "/w/pounce" },
    ];
    expect(resolveScope(scope, later).ids.has("t5")).toBe(true);
  });

  it("confines paths to the granted directories, including via ..", () => {
    const r = resolveScope(normalizeScope({ repoKeys: ["pounce-mono"] }), THREADS);
    expect(pathInScope(r, "/w/pounce")).toBe(true);
    expect(pathInScope(r, "/w/pounce/src/app.ts")).toBe(true);
    expect(pathInScope(r, "/w/client")).toBe(false);
    expect(pathInScope(r, "/w/pounce/../client/secrets.env")).toBe(false);
    // A sibling that merely shares a prefix is not inside it.
    expect(pathInScope(r, "/w/pounce-other/x")).toBe(false);
    expect(pathInScope(r, null)).toBe(false);
  });

  it("summarises for the approval sheet", () => {
    expect(scopeSummary({ kind: "full" })).toBe("Everything");
    expect(scopeSummary(normalizeScope({ repoKeys: ["a", "b"] }))).toBe("2 spaces");
    expect(scopeSummary(normalizeScope({ threads: [{ agent: "claude", id: "t1" }] }))).toBe(
      "1 thread",
    );
  });
});

describe("telling a returning machine from a stranger", () => {
  const asker = { bridgeId: "air", hostName: "Air", platform: "darwin" };

  it("marks a request from a machine that already holds access", () => {
    const api = createAccess({ store: memStore() });
    // First-time ask: nothing held yet, so nothing to warn about.
    const first = api.submit({
      kind: "read",
      requester: asker,
      scope: { kind: "scoped", repoKeys: ["a"], threads: [] },
      ip: "1",
    });
    expect(api.listPending()[0].existing).toBeNull();
    api.approve(first.requestId, { scope: { kind: "scoped", repoKeys: ["a"], threads: [] } });

    // Same machine comes back for more. The approver must be told.
    api.submit({
      kind: "read",
      requester: asker,
      scope: { kind: "scoped", repoKeys: ["a", "b"], threads: [] },
      ip: "2",
    });
    expect(api.listPending()[0].existing).toEqual({ summary: "a", expiresAt: null });
  });

  it("does not count a stranger's own in-flight preview as already connected", () => {
    const api = createAccess({ store: memStore() });
    const p = api.submit({ kind: "preview", requester: asker, ip: "1" });
    api.approve(p.requestId, {});
    // Mid-handshake: the preview is scaffolding, not standing access. Calling
    // this "wants more" would label every first-time asker a returning one.
    // (Second ip: this api uses the real clock, so the rate limiter can't be
    // wound forward the way the shared `access` fixture does it.)
    api.submit({
      kind: "read",
      requester: asker,
      scope: { kind: "scoped", repoKeys: ["a"], threads: [] },
      ip: "2",
    });
    expect(api.listPending()[0].existing).toBeNull();
  });
});

describe("route allowlist", () => {
  const read = { kind: "read", scope: { kind: "scoped", repoKeys: ["x"], threads: [] } };
  const full = { kind: "read", scope: { kind: "full" } };
  const preview = { kind: "preview", scope: null };

  it("lets a read grant browse", () => {
    for (const p of ["/v1/threads", "/v1/messages", "/v1/search", "/v1/git/changes", "/v1/usage"]) {
      expect(grantAllowsRoute(read, "GET", p)).toBe(true);
    }
  });

  it("lets a connected machine browse the catalog to ask for more", () => {
    // A peer holding a live read grant can list names and dates, so "ask for
    // more space" is a picker rather than a second stranger handshake. Scoped
    // as well as full: the scoped case is the whole point, since a machine that
    // already has everything has nothing left to ask for.
    for (const g of [read, full, preview]) {
      expect(grantAllowsRoute(g, "GET", "/v1/catalog/spaces")).toBe(true);
      expect(grantAllowsRoute(g, "GET", "/v1/catalog/threads")).toBe(true);
    }
    // Still names only, and still read-only.
    expect(grantAllowsRoute(preview, "GET", "/v1/messages")).toBe(false);
    expect(grantAllowsRoute(read, "POST", "/v1/catalog/spaces")).toBe(false);
  });

  it("refuses everything that writes, executes, or hands over credentials", () => {
    for (const p of [
      "/v1/exec",
      "/v1/token",
      "/v1/pair",
      "/v1/config",
      "/v1/doctor",
      "/v1/dirs",
      "/v1/files",
      "/v1/peers",
      "/v1/access",
    ]) {
      expect(grantAllowsRoute(full, "GET", p)).toBe(false);
    }
    for (const p of [
      "/v1/turn/stream",
      "/v1/session/input",
      "/v1/git/commit",
      "/v1/push/register",
    ]) {
      expect(grantAllowsRoute(full, "POST", p)).toBe(false);
    }
  });

  it("closes the write twin of an allowed read route", () => {
    expect(grantAllowsRoute(full, "GET", "/v1/context")).toBe(true);
    expect(grantAllowsRoute(full, "POST", "/v1/context")).toBe(false);
    expect(grantAllowsRoute(full, "GET", "/v1/markers")).toBe(true);
    expect(grantAllowsRoute(full, "POST", "/v1/markers")).toBe(false);
  });

  it("keeps machine-wide aggregates behind a full grant", () => {
    // Already summed across every thread — there is no per-thread row left to
    // filter, so a partial grant cannot be shown these at all.
    for (const p of ["/v1/quota", "/v1/activity"]) {
      expect(grantAllowsRoute(full, "GET", p)).toBe(true);
      expect(grantAllowsRoute(read, "GET", p)).toBe(false);
    }
  });

  it("confines a preview to the catalog", () => {
    expect(grantAllowsRoute(preview, "GET", "/v1/catalog/spaces")).toBe(true);
    expect(grantAllowsRoute(preview, "GET", "/v1/catalog/threads")).toBe(true);
    // Not even the thread list — it carries the first user message and the cwd.
    expect(grantAllowsRoute(preview, "GET", "/v1/threads")).toBe(false);
    expect(grantAllowsRoute(preview, "GET", "/v1/messages")).toBe(false);
  });

  it("denies an unknown route by default", () => {
    expect(grantAllowsRoute(full, "GET", "/v1/something-added-next-year")).toBe(false);
  });
});
