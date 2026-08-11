/**
 * The peer-access client, against a stub bridge.
 *
 * What is worth pinning here is not the happy path — apps/bridge's own suite
 * and the live two-bridge run cover the protocol — but the ways this side is
 * expected to be careful: it must never dump a peer's whole catalog by sending
 * an empty search, it must treat an unreachable local bridge as "nothing to
 * show" rather than an exception thrown into a render, and it must read a
 * clock the same way the approval sheet writes one.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import {
  DURATIONS,
  catalogSpaces,
  catalogThreads,
  expiryFor,
  listAccess,
  listPeers,
  pollAsk,
  requestRead,
  summarize,
  timeLeft,
} from "./peers";

/** Every request the stub saw, so a test can assert what was NOT sent. */
let seen: { method: string; url: string; body: string; auth: string | undefined }[] = [];
let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        body,
        auth: req.headers.authorization,
      });
      const url = new URL(req.url ?? "", "http://x");
      const json = (code: number, obj: unknown) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      // Loopback-only surface the client reads the owner token from.
      if (url.pathname === "/ui") return json(200, { token: "owner-tok" });
      if (url.pathname === "/v1/status") {
        return json(200, { status: { bridgeId: "me", device: "test-mac", version: "9.9.9" } });
      }
      if (url.pathname === "/v1/access/request")
        return json(200, { requestId: "r1", claim: "c1", code: "123456" });
      if (url.pathname.startsWith("/v1/access/request/")) {
        return json(200, { state: "approved", token: "tok", grantId: "g1", expiresAt: null });
      }
      if (url.pathname === "/v1/catalog/spaces")
        return json(200, { spaces: [{ repoKey: "a", threadCount: 2 }] });
      if (url.pathname === "/v1/catalog/threads") {
        return json(200, { threads: [{ id: "t1", agent: "claude", name: "hi", repoKey: "a" }] });
      }
      return json(404, { error: "not found" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterAll(() => server.close());
beforeEach(() => {
  seen = [];
});

describe("asking a peer", () => {
  it("identifies itself from its own bridge before asking", async () => {
    // Deliberately points the "local" bridge at the stub too, so the identity
    // lookup is observable — the real one is loopback:8099.
    process.env.EXPO_PUBLIC_BRIDGE_PORT = new URL(base).port;
    const ask = await requestRead(base, { kind: "scoped", repoKeys: ["a"], threads: [] });
    expect(ask).toMatchObject({ requestId: "r1", claim: "c1", code: "123456", peerUrl: base });

    const sent = JSON.parse(seen.find((r) => r.url === "/v1/access/request")!.body);
    expect(sent.kind).toBe("read");
    expect(sent.requester).toMatchObject({ bridgeId: "me", hostName: "test-mac" });
    // No credential: we hold none, and the route is unauthenticated by design.
    expect(seen.find((r) => r.url === "/v1/access/request")!.auth).toBeUndefined();
    // Our OWN bridge is a different matter — loopback is not enough to approve
    // access on, so those calls carry the owner token read from /ui.
    expect(seen.find((r) => r.url === "/v1/status")!.auth).toBe("Bearer owner-tok");
  });

  it("polls with the claim, which is the only thing proving it was us", async () => {
    const r = await pollAsk({ requestId: "r1", claim: "c1", code: "123456", peerUrl: base });
    expect(r.token).toBe("tok");
    expect(seen.at(-1)!.url).toBe("/v1/access/request/r1?claim=c1");
  });
});

describe("the catalog", () => {
  it("carries the preview token as a bearer", async () => {
    await catalogSpaces(base, "preview-tok");
    expect(seen.at(-1)!.auth).toBe("Bearer preview-tok");
  });

  it("refuses to ask for everything", async () => {
    // The bridge requires `q` and would 400, but the point is not to make the
    // round trip at all: an empty search box must not read as "show me all of
    // this machine's thread names".
    expect(await catalogThreads(base, "tok", "")).toEqual([]);
    expect(await catalogThreads(base, "tok", "   ")).toEqual([]);
    expect(seen).toHaveLength(0);
  });

  it("passes a real query through, scoped to a space when given one", async () => {
    const hits = await catalogThreads(base, "tok", "cli", "a");
    expect(hits).toHaveLength(1);
    expect(seen.at(-1)!.url).toBe("/v1/catalog/threads?q=cli&space=a");
  });
});

describe("our own bridge being down", () => {
  it("renders as nothing nearby, not as a thrown error", async () => {
    process.env.EXPO_PUBLIC_BRIDGE_PORT = "1"; // nothing listens here
    await expect(listPeers()).resolves.toEqual([]);
    // `devices` (phones paired over the LAN) is part of the answer now, and an
    // unreachable bridge means none of all three — not a throw.
    await expect(listAccess()).resolves.toEqual({ pending: [], grants: [], devices: [] });
  });
});

describe("scope and clock", () => {
  it("summarises a scope the same way the bridge does", () => {
    expect(summarize({ kind: "full" })).toBe("Everything");
    expect(summarize(null)).toBe("Everything");
    expect(summarize({ kind: "scoped", repoKeys: ["pounce-mono"], threads: [] })).toBe(
      "pounce-mono",
    );
    expect(summarize({ kind: "scoped", repoKeys: ["a", "b"], threads: [] })).toBe("2 spaces");
    expect(summarize({ kind: "scoped", repoKeys: [], threads: [{ agent: "c", id: "t" }] })).toBe(
      "1 thread",
    );
    expect(summarize({ kind: "scoped", repoKeys: ["a"], threads: [{ agent: "c", id: "t" }] })).toBe(
      "a + 1 thread",
    );
  });

  it("turns a duration into an absolute instant, and no-expiry into null", () => {
    expect(expiryFor(null)).toBeNull();
    const hour = expiryFor(1)!;
    expect(Date.parse(hour) - Date.now()).toBeGreaterThan(59 * 60_000);
    expect(Date.parse(hour) - Date.now()).toBeLessThanOrEqual(60 * 60_000 + 1000);
    // Every offered duration must actually produce one.
    for (const d of DURATIONS)
      expect(d.hours === null ? expiryFor(d.hours) : expiryFor(d.hours)).toBeDefined();
  });

  it("counts down in units a person reads", () => {
    const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();
    expect(timeLeft(null)).toBe("no expiry");
    expect(timeLeft(inMs(-1000))).toBe("expired");
    // The last minute must not render as "0m left" — that reads as over.
    expect(timeLeft(inMs(20_000))).toBe("under a minute");
    expect(timeLeft(inMs(20 * 60_000))).toBe("20m left");
    expect(timeLeft(inMs(3 * 3_600_000))).toBe("3h left");
    expect(timeLeft(inMs(6 * 86_400_000))).toBe("6d left");
  });
});
