/**
 * Knowing which tunnel a machine is on, and replacing it safely.
 *
 * The point of all this is that a fleet can be compared. So what's pinned here
 * is mostly the awkward cases that make a comparison lie: a binary too old to
 * say what it is, a download that isn't what the release says it is, and an
 * update that leaves the machine worse off than before it ran.
 *
 * HOME is redirected before the module loads — BIN_DIR is resolved at import.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const tmp = mkdtempSync(path.join(os.tmpdir(), "pounce-tunnelbin-"));
process.env.HOME = tmp;
process.env.USERPROFILE = tmp;
delete process.env.POUNCE_TUNNEL_BIN;
delete process.env.POUNCE_TUNNEL_URL;

const BIN_DIR = path.join(tmp, ".pounce", "bin");
const BIN = path.join(BIN_DIR, "pounce-tunnel");
const META = path.join(BIN_DIR, "pounce-tunnel.json");
const PREV = path.join(BIN_DIR, "pounce-tunnel.prev");

const mod = await import("./tunnel-bin.mjs");
const { compareVersions, fetchTunnel, latestTunnelRelease, rollbackTunnel, tunnelVersion } = mod;

/** A stand-in for the real binary: a shell script that answers `version --json`
 *  the way the Rust one does, so tunnelVersion() can be exercised for real
 *  rather than against a mock of itself. */
function fakeBinary(version, { speaks = true } = {}) {
  return speaks
    ? `#!/bin/sh\nif [ "$1" = version ]; then echo '{"version":"${version}","proto":"pounce/tunnel/1"}'; exit 0; fi\nexit 2\n`
    : `#!/bin/sh\nexit 2\n`; // pre-0.2.0: no `version` subcommand at all
}

function installFake(version, opts) {
  mkdirSync(BIN_DIR, { recursive: true });
  writeFileSync(BIN, fakeBinary(version, opts));
  chmodSync(BIN, 0o755);
}

beforeEach(() => {
  rmSync(BIN_DIR, { recursive: true, force: true });
  vi.restoreAllMocks();
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("comparing versions", () => {
  it("orders by number, not by text", () => {
    // The bug this exists to prevent: "0.10.0" < "0.9.0" as strings, which would
    // report a fleet as up to date while it sat a release behind.
    expect(compareVersions("0.9.0", "0.10.0")).toBe(-1);
    expect(compareVersions("0.10.0", "0.9.0")).toBe(1);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });

  it("sorts a prerelease below its release, and an unknown below everything", () => {
    expect(compareVersions("0.2.0-rc1", "0.2.0")).toBe(-1);
    expect(compareVersions(null, "0.1.0")).toBe(-1);
  });
});

describe("what version is this machine on", () => {
  it("asks the binary, and says so", () => {
    installFake("0.2.0");
    expect(tunnelVersion()).toEqual({
      version: "0.2.0",
      proto: "pounce/tunnel/1",
      source: "binary",
    });
  });

  it("falls back to the stamp for a binary too old to answer", () => {
    // Every tunnel in the field today. `version` arrived in 0.2.0, so on 0.1.0
    // the call exits 2 and the stamp we wrote at install time is all there is.
    installFake("0.1.0", { speaks: false });
    writeFileSync(META, JSON.stringify({ version: "0.1.0", proto: "pounce/tunnel/1" }));
    expect(tunnelVersion()).toEqual({
      version: "0.1.0",
      proto: "pounce/tunnel/1",
      source: "stamp",
    });
  });

  it("admits it cannot tell rather than reporting a confident null", () => {
    // A binary that predates both the subcommand and the stamp. The fleet view
    // has to render this state, so it must be distinguishable from "no tunnel".
    installFake("?", { speaks: false });
    expect(tunnelVersion()).toEqual({ version: null, proto: null, source: "unknown" });
  });

  it("is null when there is no tunnel at all", () => {
    expect(tunnelVersion()).toBeNull();
  });
});

// --- the download ---------------------------------------------------------------
// fetchTunnel talks to GitHub and then to the filesystem. The network half is
// stubbed; the filesystem half is real, because the atomic-swap and keep-the-old
// -one behaviour is the entire point and mocking it would test nothing.

/** A .tar.gz containing one executable named pounce-tunnel. */
function tarballOf(script) {
  const stage = mkdtempSync(path.join(os.tmpdir(), "pounce-stage-"));
  writeFileSync(path.join(stage, "pounce-tunnel"), script);
  chmodSync(path.join(stage, "pounce-tunnel"), 0o755);
  execFileSync("tar", ["czf", path.join(stage, "t.tar.gz"), "-C", stage, "pounce-tunnel"]);
  const buf = readFileSync(path.join(stage, "t.tar.gz"));
  rmSync(stage, { recursive: true, force: true });
  return buf;
}

/** Stub the two fetches fetchTunnel makes: the releases list, then the asset. */
function stubRelease(tarball, { version = "0.2.0", digest } = {}) {
  const sha = digest ?? `sha256:${createHash("sha256").update(tarball).digest("hex")}`;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    if (String(url).includes("api.github.com")) {
      return {
        ok: true,
        json: async () => [
          {
            tag_name: `tunnel-v${version}`,
            assets: [
              {
                name: `pounce-tunnel-${mod.rustTriple()}.tar.gz`,
                browser_download_url: "https://example.invalid/asset.tar.gz",
                digest: sha,
              },
            ],
          },
        ],
      };
    }
    return { ok: true, arrayBuffer: async () => tarball };
  });
}

describe("installing a new tunnel", () => {
  it("puts it in place and stamps what it is", async () => {
    stubRelease(tarballOf(fakeBinary("0.2.0")));
    const r = await fetchTunnel();
    expect(r.version).toBe("0.2.0");
    expect(existsSync(BIN)).toBe(true);
    // Stamped from the BINARY once it's in place, not merely from the tag we
    // downloaded it under — the two can disagree and the binary is right.
    expect(JSON.parse(readFileSync(META, "utf8"))).toMatchObject({
      version: "0.2.0",
      proto: "pounce/tunnel/1",
      tag: "tunnel-v0.2.0",
    });
  });

  it("refuses a download that isn't what the release says it is", async () => {
    // We are about to hand this binary control of the machine's networking.
    stubRelease(tarballOf(fakeBinary("0.2.0")), { digest: "sha256:" + "0".repeat(64) });
    await expect(fetchTunnel()).rejects.toThrow(/digest mismatch/);
    // And crucially left the machine alone: nothing half-written, nothing swapped.
    expect(existsSync(BIN)).toBe(false);
  });

  it("keeps the binary it replaced", async () => {
    installFake("0.1.0");
    stubRelease(tarballOf(fakeBinary("0.2.0")));
    await fetchTunnel();
    expect(tunnelVersion().version).toBe("0.2.0");
    expect(existsSync(PREV)).toBe(true);
  });

  it("leaves no partial binary behind when the download fails outright", async () => {
    installFake("0.1.0");
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: false, status: 500 });
    await expect(fetchTunnel()).rejects.toThrow();
    // Still on the old one, still runnable. A failed update must not be worse
    // than no update — on a remote server there may be no second way in.
    expect(tunnelVersion().version).toBe("0.1.0");
  });
});

describe("rolling back", () => {
  it("restores the previous binary and re-derives the stamp", async () => {
    installFake("0.1.0");
    stubRelease(tarballOf(fakeBinary("0.2.0")));
    await fetchTunnel();
    expect(tunnelVersion().version).toBe("0.2.0");

    expect(rollbackTunnel()).toBe(true);
    expect(tunnelVersion().version).toBe("0.1.0");
    // The stamp described the binary we just removed; leaving it would make the
    // fleet view state a version this machine is provably not running.
    const meta = JSON.parse(readFileSync(META, "utf8"));
    expect(meta.version).toBe("0.1.0");
    expect(meta.rolledBackAt).toBeTruthy();
  });

  it("says so when there is nothing to go back to", () => {
    installFake("0.2.0");
    expect(rollbackTunnel()).toBe(false);
  });
});

describe("finding the newest release", () => {
  it("reports the version and the digest alongside the url", async () => {
    stubRelease(tarballOf(fakeBinary("0.3.0")), { version: "0.3.0" });
    const latest = await latestTunnelRelease();
    expect(latest).toMatchObject({ tag: "tunnel-v0.3.0", version: "0.3.0" });
    expect(latest.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("admits it cannot know the version behind a pinned url", async () => {
    // POUNCE_TUNNEL_URL is a deliberate override (dev build, air-gapped mirror).
    // Claiming a version for it would put a fiction in the fleet view.
    process.env.POUNCE_TUNNEL_URL = "https://example.invalid/custom.tar.gz";
    try {
      expect(await latestTunnelRelease()).toMatchObject({ version: null, tag: null });
    } finally {
      delete process.env.POUNCE_TUNNEL_URL;
    }
  });
});
