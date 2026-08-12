import { describe, expect, it } from "vitest";
import { hostIsAddress } from "./host-guard.mjs";

describe("hostIsAddress", () => {
  it("accepts the addresses real clients actually send", () => {
    // The desktop window and the tunnel's local proxy.
    expect(hostIsAddress("127.0.0.1:8099")).toBe(true);
    expect(hostIsAddress("localhost:8099")).toBe(true);
    // The tunnel listens on its OWN port, so the port must not be pinned to ours.
    expect(hostIsAddress("127.0.0.1:8098")).toBe(true);
    // pairUrl and the discovery beacon are both http://<lan-ip>:<port>.
    expect(hostIsAddress("192.168.1.3:8099")).toBe(true);
    // Port is optional.
    expect(hostIsAddress("127.0.0.1")).toBe(true);
    expect(hostIsAddress("10.0.0.7")).toBe(true);
  });

  it("accepts IPv6 literals without being confused by their colons", () => {
    expect(hostIsAddress("[::1]:8099")).toBe(true);
    expect(hostIsAddress("[::1]")).toBe(true);
    expect(hostIsAddress("[fe80::1ff:fe23:4567:890a]:8099")).toBe(true);
  });

  it("refuses a DNS name — the rebinding case", () => {
    // The whole attack: the browser holds evil.com, the attacker's DNS answers
    // 127.0.0.1 for it, and the request arrives on a loopback socket with no
    // Origin. This header is the only thing that still names the attacker.
    expect(hostIsAddress("evil.attacker.com:8099")).toBe(false);
    expect(hostIsAddress("evil.attacker.com")).toBe(false);
    // A name that merely LOOKS local is still a name someone had to resolve.
    expect(hostIsAddress("localhost.evil.com:8099")).toBe(false);
    expect(hostIsAddress("mac.local:8099")).toBe(false);
    expect(hostIsAddress("127.0.0.1.evil.com:8099")).toBe(false);
  });

  it("allows an absent Host but not a malformed one", () => {
    // No browser omits Host, so its absence is a non-browser client.
    expect(hostIsAddress(undefined)).toBe(true);
    expect(hostIsAddress(null)).toBe(true);
    expect(hostIsAddress("")).toBe(true);
    // Anything that is not a string never came from a parsed request line.
    expect(hostIsAddress(["127.0.0.1"])).toBe(false);
    expect(hostIsAddress("[not-an-ip]:8099")).toBe(false);
  });
});
