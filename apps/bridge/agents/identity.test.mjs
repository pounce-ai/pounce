import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// store.mjs resolves ~/.pounce at import time, so HOME must point at a scratch
// dir before it (or anything importing it) is loaded.
const tmp = mkdtempSync(path.join(os.tmpdir(), "pounce-identity-"));
process.env.HOME = tmp;
process.env.USERPROFILE = tmp;

const { bridgeId, machineFingerprint, identitySource, _reset } = await import("./identity.mjs");

beforeEach(() => _reset());
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("machineFingerprint", () => {
  it("reads the OS machine identifier on a supported platform", () => {
    const fp = machineFingerprint();
    if (["darwin", "linux", "win32"].includes(process.platform)) {
      expect(typeof fp).toBe("string");
      expect(fp.length).toBeGreaterThan(8);
    } else {
      expect(fp).toBeNull(); // unsupported host falls back, and that's fine
    }
  });
});

describe("bridgeId", () => {
  it("is stable across restarts", () => {
    const first = bridgeId();
    _reset(); // a fresh process re-derives (or re-reads) it
    expect(bridgeId()).toBe(first);
  });

  it("survives losing the state directory entirely", () => {
    // The case a stored random id gets wrong: Store.flush swallows write errors,
    // so an unwritable ~/.pounce would otherwise mint a new id every boot and add
    // a device row each time.
    const before = bridgeId();
    rmSync(path.join(tmp, ".pounce"), { recursive: true, force: true });
    _reset();
    if (machineFingerprint()) {
      expect(bridgeId()).toBe(before); // derived: no persistence needed
    } else {
      expect(typeof bridgeId()).toBe("string"); // fallback host: a new id is expected
    }
  });

  it("never exposes the raw machine identifier", () => {
    // What leaves the machine is scoped to Pounce, not the OS value itself.
    const fp = machineFingerprint();
    const id = bridgeId();
    if (fp) {
      expect(id).not.toContain(fp);
      expect(id).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it("is not derived from the hostname", () => {
    // Hostnames collide between machines and users rename them freely.
    expect(bridgeId()).not.toContain(os.hostname());
    expect(bridgeId()).not.toContain(os.hostname().replace(/\.local$/, ""));
  });

  it("reports how it was derived", () => {
    const src = identitySource();
    expect(src).toBe(machineFingerprint() ? "os-machine-id" : "random-persisted");
  });
});
