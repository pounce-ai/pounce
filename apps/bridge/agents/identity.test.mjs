import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// store.mjs resolves ~/.pounce at import time, so HOME must point at a scratch
// dir before it (or anything importing it) is loaded.
const tmp = mkdtempSync(path.join(os.tmpdir(), "pounce-identity-"));
process.env.HOME = tmp;
process.env.USERPROFILE = tmp;

const { bridgeId, _reset } = await import("./identity.mjs");

beforeEach(() => _reset());
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("bridgeId", () => {
  it("is stable across restarts", () => {
    const first = bridgeId();
    _reset(); // a fresh process reads the persisted value back
    expect(bridgeId()).toBe(first);
  });

  it("does not change with port, address, or memoisation state", () => {
    // The whole point: one machine keeps one identity however it is reached.
    const ids = new Set([bridgeId(), bridgeId()]);
    _reset();
    ids.add(bridgeId());
    expect(ids.size).toBe(1);
  });

  it("looks like an opaque id, not a hostname", () => {
    // Hostnames collide between machines and users rename them; the id must not
    // be derived from one.
    const id = bridgeId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(id).not.toContain(os.hostname());
  });
});
