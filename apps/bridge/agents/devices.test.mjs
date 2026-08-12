import { beforeEach, describe, expect, it } from "vitest";
import { createDevices } from "./devices.mjs";

/** In-memory stand-in for Store — same surface, no ~/.pounce. */
function fakeStore() {
  const rows = new Map();
  return {
    rows,
    get: (k) => rows.get(k),
    set: (k, v) => rows.set(k, v),
    delete: (k) => rows.delete(k),
    withPrefix: (p) => Object.fromEntries([...rows].filter(([k]) => k.startsWith(p))),
  };
}

describe("per-device credentials", () => {
  let store;
  let devices;
  beforeEach(() => {
    store = fakeStore();
    devices = createDevices({ store, now: () => 1000 });
  });

  it("mints a credential that resolves back to its device", () => {
    const { id, token } = devices.mint({ key: "phone-1", name: "iPhone", platform: "ios" });
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(devices.forToken(token)?.id).toBe(id);
    expect(devices.forToken(token)?.name).toBe("iPhone");
  });

  it("never stores the plaintext", () => {
    const { token } = devices.mint({ key: "phone-1" });
    expect(JSON.stringify([...store.rows.values()])).not.toContain(token);
  });

  it("refuses anything that is not a live credential", () => {
    devices.mint({ key: "phone-1" });
    expect(devices.forToken("wrong")).toBe(null);
    expect(devices.forToken("")).toBe(null);
    expect(devices.forToken(null)).toBe(null);
    expect(devices.forToken(undefined)).toBe(null);
  });

  it("keeps devices independent — revoking one leaves the others working", () => {
    // The property the whole file exists for. Removing a phone used to mean
    // rotating the shared token, which ended every other device too.
    const a = devices.mint({ key: "phone-a" });
    const b = devices.mint({ key: "phone-b" });
    expect(devices.revoke(a.id)).toBe(true);
    expect(devices.forToken(a.token)).toBe(null);
    expect(devices.forToken(b.token)?.id).toBe(b.id);
  });

  it("re-minting under one key replaces that device rather than stacking a row", () => {
    const first = devices.mint({ key: "phone-1", name: "iPhone" });
    const second = devices.mint({ key: "phone-1", name: "iPhone" });
    expect(devices.count()).toBe(1);
    // The old credential stops working; a reinstalled phone has exactly one.
    expect(devices.forToken(first.token)).toBe(null);
    expect(devices.forToken(second.token)?.id).toBe(second.id);
  });

  it("keeps the original pairing date across a re-mint", () => {
    devices.mint({ key: "phone-1" });
    const later = createDevices({ store, now: () => 9999 });
    later.mint({ key: "phone-1" });
    expect(later.list()[0].pairedAt).toBe(new Date(1000).toISOString());
  });

  it("mints an id when the caller has no stable key", () => {
    const one = devices.mint();
    const two = devices.mint();
    expect(one.id).not.toBe(two.id);
    expect(devices.count()).toBe(2);
  });

  it("reports last-seen only once the device has actually called", () => {
    const { id } = devices.mint({ key: "phone-1" });
    expect(devices.list()[0].lastSeenAt).toBe(null);
    devices.touch(id);
    expect(devices.list()[0].lastSeenAt).toBe(new Date(1000).toISOString());
  });

  it("survives a token rotation, which is the point", () => {
    // Nothing here reads the shared bridge token, so rotating it — an upgrade,
    // a reinstall, a torn ~/.pounce — cannot invalidate an adopted credential.
    const { token } = devices.mint({ key: "phone-1" });
    const afterRestart = createDevices({ store, now: () => 2000 });
    expect(afterRestart.forToken(token)?.id).toBe("phone-1");
  });
});
