/**
 * The bridge credential and its migration window.
 *
 * The behaviour under test is a security fix: `pounce-bridge-local` was a
 * published password on a service exposing /v1/exec. These pin the two halves of
 * replacing it — a real random secret for new installs, and a window narrow
 * enough that the old one can't be used for anything that matters.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LEGACY_TOKEN, bridgeToken, legacyAllows, tokenMatches, _reset } from "./token.mjs";

let dir;
const file = () => path.join(dir, "token.json");
const mint = () => bridgeToken({ dir, file: file() });

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "pounce-token-"));
  delete process.env.BRIDGE_TOKEN;
  _reset();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  _reset();
});

describe("bridgeToken", () => {
  it("mints a 256-bit secret instead of the published constant", () => {
    const { token } = mint();
    expect(token).not.toBe(LEGACY_TOKEN);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("persists it 0600 and reuses it across restarts", () => {
    const first = mint().token;
    expect(statSync(file()).mode & 0o777).toBe(0o600);
    _reset();
    expect(mint().token).toBe(first);
    expect(JSON.parse(readFileSync(file(), "utf8")).token).toBe(first);
  });

  it("opens NO legacy window on a fresh install", () => {
    // Nothing was ever paired, so nothing holds the old token — accepting it
    // would only expose a brand-new install for no benefit.
    expect(mint().legacyUntil).toBe(0);
  });

  it("opens a bounded window when upgrading an install that has state", () => {
    mkdirSync(path.join(dir, "state"), { recursive: true });
    const { legacyUntil } = mint();
    expect(legacyUntil).toBeGreaterThan(Date.now());
    expect(legacyUntil).toBeLessThanOrEqual(Date.now() + 24 * 3600_000);
  });

  it("lets BRIDGE_TOKEN win, and never opens the window for it", () => {
    mkdirSync(path.join(dir, "state"), { recursive: true });
    process.env.BRIDGE_TOKEN = "from-the-cli";
    expect(mint()).toEqual({ token: "from-the-cli", legacyUntil: 0 });
  });

  it("keeps a pairing alive rather than re-minting when ~/.pounce is unwritable", () => {
    // A token that changed on every restart would break every paired device on
    // each one — worse than the shared default it replaces.
    writeFileSync(path.join(dir, "blocked"), "i am a file, not a directory");
    const { token } = bridgeToken({ dir, file: path.join(dir, "blocked", "token.json") });
    expect(token).toBe(LEGACY_TOKEN);
  });

  it("ignores a torn file and mints again", () => {
    writeFileSync(file(), "{not json");
    expect(mint().token).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("tokenMatches", () => {
  it("compares without leaking length or content", () => {
    expect(tokenMatches("abc", "abc")).toBe(true);
    expect(tokenMatches("abc", "abd")).toBe(false);
    expect(tokenMatches("abc", "abcd")).toBe(false);
    expect(tokenMatches(undefined, "abc")).toBe(false);
    expect(tokenMatches("abc", undefined)).toBe(false);
  });
});

describe("legacyAllows", () => {
  it("permits plain reads so a stale device keeps syncing", () => {
    expect(legacyAllows("GET", "/v1/threads")).toBe(true);
    expect(legacyAllows("GET", "/v1/messages")).toBe(true);
    expect(legacyAllows("GET", "/v1/status")).toBe(true);
  });

  it("refuses everything that changes the machine", () => {
    expect(legacyAllows("POST", "/v1/turn/stream")).toBe(false);
    expect(legacyAllows("POST", "/v1/exec")).toBe(false);
    expect(legacyAllows("GET", "/v1/exec")).toBe(false);
    expect(legacyAllows("POST", "/v1/config")).toBe(false);
    expect(legacyAllows("POST", "/v1/daemon/restart")).toBe(false);
  });

  it("refuses the routes that would hand over a credential", () => {
    // Both are GETs, so a method-only rule would have leaked them: /v1/pair
    // returns the token for the tunnel, /v1/config the provider keys.
    expect(legacyAllows("GET", "/v1/pair")).toBe(false);
    expect(legacyAllows("GET", "/v1/config")).toBe(false);
  });

  it("allows exactly one thing so the window can close itself", () => {
    expect(legacyAllows("GET", "/v1/token")).toBe(true);
  });
});
