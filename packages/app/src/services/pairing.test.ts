import { beforeEach, describe, expect, it, vi } from "vitest";
import { pairFromParams, pairingHostName, parsePairing } from "./pairing";
import { connectBridge, dialPairingTunnel, redeemPairCode } from "./bridge";
import { savePairing } from "./runtime";

vi.mock("./bridge", () => ({
  connectBridge: vi.fn(async () => true),
  dialPairingTunnel: vi.fn(async () => null),
  redeemPairCode: vi.fn(async () => null),
}));
vi.mock("./runtime", () => ({ savePairing: vi.fn(async () => {}) }));

describe("parsePairing", () => {
  it("parses the LAN-only deep link (pre-tunnel QR codes)", () => {
    const p = parsePairing(
      "pounce://connect?url=http%3A%2F%2F192.168.1.6%3A8099&token=pounce-bridge-local",
    );
    expect(p).toEqual({ url: "http://192.168.1.6:8099", token: "pounce-bridge-local" });
  });

  it("parses the tunnel-carrying deep link (npx / SSH QR codes)", () => {
    const link =
      "pounce://connect?url=http%3A%2F%2F10.0.0.5%3A8099&token=s3cret" +
      "&node=ab12cd34ef&host=dirgha-mbp&relay=https%3A%2F%2Fuse1-1.relay.iroh.network.%2F";
    expect(parsePairing(link)).toEqual({
      url: "http://10.0.0.5:8099",
      token: "s3cret",
      nodeId: "ab12cd34ef",
      relay: "https://use1-1.relay.iroh.network./",
      hostName: "dirgha-mbp",
    });
  });

  it("parses the one-time-code deep link (what bridges emit now)", () => {
    const link =
      "pounce://connect?url=http%3A%2F%2F192.168.1.6%3A8099&code=6e90cfc2b457f32fc4bcd469593dde4d" +
      "&node=ab12cd34ef&host=dirgha-mbp";
    expect(parsePairing(link)).toEqual({
      url: "http://192.168.1.6:8099",
      code: "6e90cfc2b457f32fc4bcd469593dde4d",
      nodeId: "ab12cd34ef",
      hostName: "dirgha-mbp",
    });
  });

  it("parses the pairing-tunnel identity, so a code can be spent off-LAN", () => {
    const link =
      "pounce://connect?url=http%3A%2F%2F10.0.0.5%3A8099&code=c0de" +
      "&node=ab12cd34ef&host=srv&pnode=fe98dc76ba&prelay=https%3A%2F%2Frelay.example%2F";
    expect(parsePairing(link)).toEqual({
      url: "http://10.0.0.5:8099",
      code: "c0de",
      nodeId: "ab12cd34ef",
      hostName: "srv",
      pairNode: "fe98dc76ba",
      pairRelay: "https://relay.example/",
    });
  });

  it("ignores a pairing-tunnel identity on a legacy token link", () => {
    // The pairing door's handshake accepts a CODE; a token link has none to
    // spend there, and the token already opens the machine-wide tunnel.
    const p = parsePairing("pounce://connect?url=http%3A%2F%2Fa%3A1&token=t&pnode=x");
    expect(p).toEqual({ url: "http://a:1", token: "t" });
  });

  it("never reports a code as a token", () => {
    // The two are spent differently — a token is a bearer credential, a code
    // buys exactly one adopt — so a caller must not be able to confuse them.
    const p = parsePairing("pounce://connect?url=http%3A%2F%2Fa%3A1&code=abc");
    expect(p?.token).toBeUndefined();
    expect(p?.code).toBe("abc");
  });

  it("prefers the code when a link somehow carries both", () => {
    const p = parsePairing("pounce://connect?url=http%3A%2F%2Fa%3A1&token=t&code=c");
    expect(p).toEqual({ url: "http://a:1", code: "c" });
  });

  it("parses raw JSON carrying a code", () => {
    expect(parsePairing('{"url":"http://a:1","code":"c"}')).toEqual({
      url: "http://a:1",
      code: "c",
    });
  });

  it("ignores relay/host without a node id", () => {
    const p = parsePairing("pounce://connect?url=http%3A%2F%2Fa%3A1&token=t&relay=r&host=h");
    expect(p).toEqual({ url: "http://a:1", token: "t" });
  });

  it("parses raw JSON, with and without the tunnel identity", () => {
    expect(parsePairing('{"url":"http://a:1","token":"t"}')).toEqual({
      url: "http://a:1",
      token: "t",
    });
    expect(
      parsePairing('{"url":"http://a:1","token":"t","nodeId":"n","relay":"r","hostName":"mac"}'),
    ).toEqual({
      url: "http://a:1",
      token: "t",
      nodeId: "n",
      relay: "r",
      hostName: "mac",
    });
  });

  it("rejects incomplete or unrelated codes", () => {
    expect(parsePairing("pounce://connect?url=http%3A%2F%2Fa%3A1")).toBeNull(); // no token or code
    expect(parsePairing("https://example.com")).toBeNull();
    expect(parsePairing("WIFI:S:MyNetwork;T:WPA;P:hunter2;;")).toBeNull();
    expect(parsePairing("{}")).toBeNull();
  });
});

describe("pairFromParams — spending a code away from the host's network", () => {
  beforeEach(() => {
    vi.mocked(redeemPairCode).mockReset().mockResolvedValue(null);
    vi.mocked(dialPairingTunnel).mockReset().mockResolvedValue(null);
    vi.mocked(connectBridge).mockClear();
    vi.mocked(savePairing).mockClear();
  });

  it("redeems through the pairing tunnel when the LAN address is unreachable", async () => {
    // LAN redemption fails (the QR's url is on the SERVER's network), the
    // pairing-tunnel dial lands a loopback base, and the code redeems there.
    vi.mocked(redeemPairCode).mockImplementation(async (base) =>
      base === "http://127.0.0.1:54321" ? { token: "dev-tok", tunnelToken: "tun-sec" } : null,
    );
    vi.mocked(dialPairingTunnel).mockResolvedValue("http://127.0.0.1:54321");

    const ok = await pairFromParams({
      url: "http://10.0.0.5:8099",
      code: "c0de",
      node: "main-node",
      relay: "https://relay.example/",
      host: "srv",
      pairNode: "pair-node",
      pairRelay: "https://relay.example/",
    });

    expect(ok).toBe(true);
    expect(dialPairingTunnel).toHaveBeenCalledWith("pair-node", "https://relay.example/", "c0de");
    // Everything the device keeps came from the adopt response + the link:
    // its own token, the tunnel secret, and the MAIN tunnel's identity.
    expect(connectBridge).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "http://10.0.0.5:8099",
        token: "dev-tok",
        tunnelToken: "tun-sec",
        nodeId: "main-node",
        adopted: true,
      }),
    );
  });

  it("never dials the pairing tunnel when the LAN redemption worked", async () => {
    vi.mocked(redeemPairCode).mockResolvedValue({ token: "dev-tok", tunnelToken: "tun-sec" });
    const ok = await pairFromParams({
      url: "http://192.168.1.6:8099",
      code: "c0de",
      pairNode: "pair-node",
    });
    expect(ok).toBe(true);
    expect(dialPairingTunnel).not.toHaveBeenCalled();
  });

  it("fails cleanly when both paths are dead — the code is not stored anywhere", async () => {
    const ok = await pairFromParams({
      url: "http://10.0.0.5:8099",
      code: "c0de",
      pairNode: "pair-node",
    });
    expect(ok).toBe(false);
    expect(connectBridge).not.toHaveBeenCalled();
    expect(savePairing).not.toHaveBeenCalled();
  });
});

describe("pairingHostName", () => {
  it("prefers the explicit host label", () => {
    expect(
      pairingHostName({ url: "http://192.168.1.6:8099", token: "t", hostName: "dirgha-mbp" }),
    ).toBe("dirgha-mbp");
  });

  it("falls back to the LAN address's host part", () => {
    expect(pairingHostName({ url: "http://192.168.1.6:8099", token: "t" })).toBe("192.168.1.6");
  });
});
