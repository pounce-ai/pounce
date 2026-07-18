import { describe, expect, it } from "vitest";
import { pairingHostName, parsePairing } from "./pairing";

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
    expect(parsePairing("pounce://connect?url=http%3A%2F%2Fa%3A1")).toBeNull(); // no token
    expect(parsePairing("https://example.com")).toBeNull();
    expect(parsePairing("WIFI:S:MyNetwork;T:WPA;P:hunter2;;")).toBeNull();
    expect(parsePairing("{}")).toBeNull();
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
