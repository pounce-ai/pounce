/**
 * Dialling a peer through our own bridge.
 *
 * This is the only way the desktop reaches a machine added over SSH — that
 * machine's `url` is an address on its own network, so the tunnel is not a
 * fallback there, it is the whole route. The route is an OWNER route: loopback
 * is necessary but not sufficient, and the bridge answers 401 without a token.
 *
 * It shipped as a bare `fetch` with no credential, and the 401 was swallowed as
 * "no tunnel available". The machine then sat in Devices as Offline forever,
 * with none of its threads and nothing on screen saying why. Hence a stub that
 * enforces auth exactly as the real bridge does.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { dialPeer } from "./ownBridge";

let seen: { url: string; body: string; auth: string | undefined }[] = [];
let server: Server;
let base: string;
/** Flipped per-test to make the bridge behave like one that can't get there. */
let dialAnswer: { code: number; body: unknown } = { code: 200, body: { port: 51234 } };

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen.push({ url: req.url ?? "", body, auth: req.headers.authorization });
      const json = (code: number, obj: unknown) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      if (req.url === "/ui") return json(200, { token: "owner-tok" });
      if (req.url === "/v1/peers/dial") {
        // The real gate: every route below /ui is behind the token check, and
        // being on loopback earns you nothing.
        if (req.headers.authorization !== "Bearer owner-tok") {
          return json(401, { error: "unauthorized" });
        }
        return json(dialAnswer.code, dialAnswer.body);
      }
      return json(404, { error: "not found" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  process.env.EXPO_PUBLIC_BRIDGE_PORT = new URL(base).port;
});

afterAll(() => server.close());
beforeEach(() => {
  seen = [];
  dialAnswer = { code: 200, body: { port: 51234 } };
});

describe("dialling a peer through our own bridge", () => {
  it("authenticates, and comes back with the loopback port", async () => {
    expect(await dialPeer("node-abc", "https://relay.example", "peer-tok")).toBe(51234);

    const dial = seen.find((r) => r.url === "/v1/peers/dial")!;
    // The regression itself. Without this header the bridge 401s and an
    // SSH-added machine is unreachable by any route at all.
    expect(dial.auth).toBe("Bearer owner-tok");
    // The peer's own handshake secret, not ours — the two are different
    // credentials and sending the wrong one fails at QUIC, not at HTTP.
    expect(JSON.parse(dial.body)).toEqual({
      nodeId: "node-abc",
      relay: "https://relay.example",
      token: "peer-tok",
    });
  });

  it("sends no relay rather than a null one when there is none", async () => {
    await dialPeer("node-abc", null, "peer-tok");
    expect(JSON.parse(seen.find((r) => r.url === "/v1/peers/dial")!.body).relay).toBeNull();
  });

  it("reports a bridge that cannot reach the peer as no port, not a throw", async () => {
    // 503 is what the bridge sends when it has no tunnel binary and can't
    // fetch one. The caller's job is to fall back to the LAN address.
    dialAnswer = { code: 503, body: { error: "no tunnel binary on this machine" } };
    await expect(dialPeer("node-abc", null, "peer-tok")).resolves.toBeNull();
  });

  it("treats no local bridge at all as no port", async () => {
    const port = process.env.EXPO_PUBLIC_BRIDGE_PORT;
    process.env.EXPO_PUBLIC_BRIDGE_PORT = "1"; // nothing listens here
    await expect(dialPeer("node-abc", null, "peer-tok")).resolves.toBeNull();
    process.env.EXPO_PUBLIC_BRIDGE_PORT = port;
  });
});
