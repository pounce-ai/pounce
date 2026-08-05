import { describe, expect, it } from "vitest";
import { type DeviceIdentity, deviceId, resolveAdoption, resolvePairing } from "./deviceIdentity";

interface Cfg extends DeviceIdentity {
  name: string;
}
const make = (base: DeviceIdentity & { name: string }): Cfg => base as Cfg;

const LAN = "http://192.168.1.3:8099";
const LOOPBACK = "http://127.0.0.1:8101";
const EMULATOR = "http://10.0.2.2:8101";
const MAC = "mac-uuid-1";

describe("deviceId", () => {
  it("uses the bridge's own id when it has one", () => {
    expect(deviceId(LAN, MAC)).toBe(`dev:${MAC}`);
    // Same machine, three addresses, one identity.
    expect(deviceId(LOOPBACK, MAC)).toBe(deviceId(LAN, MAC));
    expect(deviceId(EMULATOR, MAC)).toBe(deviceId(LAN, MAC));
  });

  it("falls back to the URL for a bridge that can't name itself", () => {
    expect(deviceId(LAN)).toBe("dev:http19216813" + "8099");
    expect(deviceId(LAN)).not.toBe(deviceId(LOOPBACK));
  });
});

describe("resolvePairing", () => {
  it("reuses the existing device when the same machine is paired at a new address", () => {
    const existing: Cfg[] = [
      { id: `dev:${MAC}`, url: LAN, token: "old", bridgeId: MAC, name: "Dirghas-Mac-mini" },
    ];
    const r = resolvePairing(
      existing,
      { url: EMULATOR, token: "new", bridgeId: MAC, name: "10.0.2.2" },
      make,
    );

    expect(r.reused).toBe(true);
    expect(r.configs).toHaveLength(1); // the duplicate row that used to appear
    expect(r.device.id).toBe(`dev:${MAC}`);
    expect(r.device.url).toBe(EMULATOR); // repointed at what actually reached it
    expect(r.device.token).toBe("new");
    expect(r.device.name).toBe("Dirghas-Mac-mini"); // keeps the name you knew it by
  });

  it("adds a genuinely different machine", () => {
    const existing: Cfg[] = [
      { id: `dev:${MAC}`, url: LAN, token: "t", bridgeId: MAC, name: "mac-mini" },
    ];
    const r = resolvePairing(
      existing,
      { url: "http://192.168.1.9:8099", token: "t2", bridgeId: "other-uuid", name: "192.168.1.9" },
      make,
    );

    expect(r.reused).toBe(false);
    expect(r.configs).toHaveLength(2);
    expect(r.device.id).toBe("dev:other-uuid");
  });

  it("still keys on the URL when the bridge reports no id", () => {
    const r = resolvePairing(
      [],
      { url: LAN, token: "t", bridgeId: null, name: "192.168.1.3" },
      make,
    );
    expect(r.device.id).toBe(deviceId(LAN));
    expect(r.device.bridgeId).toBeUndefined();
  });

  it("replaces the same URL rather than stacking it", () => {
    const first = resolvePairing([], { url: LAN, token: "a", bridgeId: null, name: "n" }, make);
    const second = resolvePairing(
      first.configs,
      { url: LAN, token: "b", bridgeId: null, name: "n" },
      make,
    );
    expect(second.configs).toHaveLength(1);
    expect(second.configs[0].token).toBe("b");
  });
});

describe("resolveAdoption", () => {
  it("collapses three URL-keyed rows for one machine into a single device", () => {
    // Exactly the reported state: one Mac reached three ways, plus a real second
    // machine that must be left alone.
    const list: Cfg[] = [
      { id: deviceId(LAN), url: LAN, token: "t", name: "Dirghas-Mac-mini" },
      { id: deviceId(LOOPBACK), url: LOOPBACK, token: "t", name: "127.0.0.1" },
      { id: deviceId(EMULATOR), url: EMULATOR, token: "t", name: "10.0.2.2" },
      { id: deviceId("http://other:8099"), url: "http://other:8099", token: "t", name: "other" },
    ];

    let cfgs = list;
    const merged: string[] = [];
    for (const cfg of list.slice(0, 3)) {
      const cur = cfgs.find((c) => c.id === cfg.id);
      if (!cur) continue; // already folded into the survivor
      const r = resolveAdoption(cfgs, cur, MAC);
      cfgs = r.configs;
      merged.push(...r.merges);
    }

    expect(cfgs).toHaveLength(2); // the Mac, plus the untouched other machine
    expect(cfgs.filter((c) => c.bridgeId === MAC)).toHaveLength(1);
    expect(cfgs.some((c) => c.name === "other")).toBe(true);
    // Every stale row's threads get a home rather than being dropped.
    expect(merged.length).toBeGreaterThan(0);
    expect(merged).not.toContain(deviceId("http://other:8099"));
  });

  it("keeps the device that already owns the machine, and reports the merge", () => {
    const list: Cfg[] = [
      { id: `dev:${MAC}`, url: LAN, token: "t", bridgeId: MAC, name: "Dirghas-Mac-mini" },
      { id: deviceId(EMULATOR), url: EMULATOR, token: "t2", name: "10.0.2.2" },
    ];
    const r = resolveAdoption(list, list[1], MAC);

    expect(r.survivorId).toBe(`dev:${MAC}`);
    expect(r.merges).toEqual([deviceId(EMULATOR)]);
    expect(r.configs).toHaveLength(1);
    expect(r.configs[0].name).toBe("Dirghas-Mac-mini");
    expect(r.configs[0].url).toBe(EMULATOR); // the address we just proved works
  });

  it("is a no-op once a device is already identified", () => {
    const list: Cfg[] = [{ id: `dev:${MAC}`, url: LAN, token: "t", bridgeId: MAC, name: "mac" }];
    const r = resolveAdoption(list, list[0], MAC);
    expect(r.merges).toEqual([]);
    expect(r.survivorId).toBe(`dev:${MAC}`);
    expect(r.configs).toEqual(list);
  });

  it("never folds two genuinely different machines together", () => {
    const other = "http://other:8099";
    const list: Cfg[] = [
      { id: `dev:${MAC}`, url: LAN, token: "t", bridgeId: MAC, name: "mac" },
      { id: deviceId(other), url: other, token: "t", name: "other" },
    ];
    const r = resolveAdoption(list, list[1], "different-uuid");

    // Both machines survive, each under its own identity.
    expect(r.configs).toHaveLength(2);
    expect(r.survivorId).toBe("dev:different-uuid");
    expect(r.configs.some((c) => c.id === `dev:${MAC}`)).toBe(true);
    // The one merge is this device onto ITSELF under its new id — without it,
    // everything synced under the old URL-derived key would be stranded.
    expect(r.merges).toEqual([deviceId(other)]);
    expect(r.merges).not.toContain(`dev:${MAC}`);
  });
});
