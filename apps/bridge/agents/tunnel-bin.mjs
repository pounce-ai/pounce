/**
 * Making sure this machine has `pounce-tunnel`.
 *
 * The tunnel is what turns a bridge into something reachable from off its own
 * network, and it's needed on BOTH ends: the remote runs `serve`, and whoever
 * dials it runs `client`. The CLI has always fetched it for the machine it runs
 * on (apps/cli/bin/pounce.mjs), but the bridge never has — it looked for the
 * binary and gave up if it was missing. That was fine while the only way to add
 * a remote machine was to scan a QR from a phone, which dials with its own
 * embedded tunnel. It stops being fine the moment the DESKTOP adds a machine:
 * dialPeer needs the binary right here, and a fresh Mac has never had a reason
 * to download one.
 *
 * Best-effort throughout. A failure here means off-LAN access doesn't work,
 * which is exactly where we already were.
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const IS_WIN = process.platform === "win32";
const BIN_DIR = path.join(os.homedir(), ".pounce", "bin");
const BIN_NAME = IS_WIN ? "pounce-tunnel.exe" : "pounce-tunnel";
/** What we installed, stamped at download time. The binary is authoritative
 *  about itself, but only since it learned `version` — this covers the ones
 *  already in the field, and survives a binary that won't run at all. */
const META_NAME = "pounce-tunnel.json";
/** The binary we replaced, kept so a bad update can be undone on a machine we
 *  may have just cut ourselves off from. */
const PREV_NAME = IS_WIN ? "pounce-tunnel.prev.exe" : "pounce-tunnel.prev";

/** How many pages of releases to look through for a `tunnel-v*` tag.
 *
 *  The CLI reads one page of 30, which was fine when the tunnel release was
 *  recent and is not fine now: desktop-v* releases have pushed tunnel-v0.1.0 to
 *  23rd of 30, and a handful more would push it off the page entirely — turning
 *  every new install silently LAN-only. 100 per page, three pages deep. */
const RELEASE_PAGES = 3;
const RELEASES_API = "https://api.github.com/repos/pounce-ai/pounce/releases";

export function rustTriple() {
  const arch = { arm64: "aarch64", x64: "x86_64" }[process.arch];
  const osPart = { darwin: "apple-darwin", linux: "unknown-linux-gnu", win32: "pc-windows-msvc" }[
    process.platform
  ];
  return arch && osPart ? `${arch}-${osPart}` : null;
}

/**
 * Where the binary lives if we have it. ONE list, and the only one — doctor
 * used to keep a second copy of this that searched a different order, so the
 * version it reported could describe a different binary than the bridge was
 * actually running. Two answers to "which tunnel is this machine on" is the
 * drift the version reporting exists to catch, so there is now one answer.
 *
 * Order matters:
 *   1. An explicit override — a dev build or a distro package, deliberately set.
 *   2. What we downloaded. An update writes here, so it MUST outrank the
 *      shipped copy or updating would silently do nothing.
 *   3. A copy bundled next to the launcher, for an install that has never
 *      reached GitHub.
 */
export function tunnelBinary() {
  const candidates = [
    process.env.POUNCE_TUNNEL_BIN,
    path.join(BIN_DIR, BIN_NAME),
    new URL(`../tunnel/${BIN_NAME}`, import.meta.url).pathname,
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) || null;
}

/** The asset name this machine needs. */
function wantedAsset(triple) {
  return `pounce-tunnel-${triple}${IS_WIN ? ".zip" : ".tar.gz"}`;
}

/**
 * The newest `tunnel-v*` release carrying a build for this machine.
 *
 * Releases come back newest-first, so the first match wins and that is the
 * definition of "latest" the whole update story rests on. Returns the digest
 * too — GitHub publishes a `sha256:` per asset, so a binary we are about to put
 * in charge of this machine's networking can be checked rather than trusted.
 */
export async function latestTunnelRelease(triple = rustTriple()) {
  if (!triple) return null;
  const wanted = wantedAsset(triple);
  if (process.env.POUNCE_TUNNEL_URL) {
    // A pinned URL is a deliberate override (dev builds, air-gapped mirrors).
    // We can't know its version, and saying so beats guessing.
    return { tag: null, version: null, url: process.env.POUNCE_TUNNEL_URL, digest: null };
  }
  for (let page = 1; page <= RELEASE_PAGES; page++) {
    const res = await fetch(`${RELEASES_API}?per_page=100&page=${page}`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "pounce-bridge" },
      signal: AbortSignal.timeout(10_000),
    });
    // Unauthenticated GitHub allows 60 requests an hour per IP, and a shared
    // office or cloud NAT burns that fast. Nothing to do but stay LAN-only.
    if (!res.ok) throw new Error(`releases -> ${res.status}`);
    const releases = await res.json();
    if (!Array.isArray(releases) || releases.length === 0) return null;
    for (const r of releases) {
      if (!r.tag_name?.startsWith("tunnel-v")) continue;
      const asset = (r.assets || []).find((a) => a.name === wanted);
      if (asset) {
        return {
          tag: r.tag_name,
          version: r.tag_name.slice("tunnel-v".length),
          url: asset.browser_download_url,
          digest: asset.digest ?? null,
        };
      }
    }
    if (releases.length < 100) return null;
  }
  return null;
}

async function findAssetUrl() {
  return (await latestTunnelRelease())?.url ?? null;
}

function extractInto(buf, dir) {
  const archive = path.join(dir, IS_WIN ? "t.zip" : "t.tar.gz");
  writeFileSync(archive, buf);
  // bsdtar ships with Windows 10+, so one tool covers every platform.
  const r = IS_WIN
    ? spawnSync("tar", ["-xf", archive, "-C", dir])
    : spawnSync("tar", ["xzf", archive, "-C", dir]);
  if (r.status !== 0) throw new Error("extract failed");
  const found = readdirSync(dir, { recursive: true }).find(
    (f) => path.basename(String(f)) === BIN_NAME,
  );
  if (!found) throw new Error(`${BIN_NAME} not in archive`);
  return path.join(dir, String(found));
}

/**
 * Does this file actually behave like `pounce-tunnel`?
 *
 * Run it with no arguments: every real build prints its usage (which names
 * `serve`) and exits non-zero. A stub, a text file, or a build for the wrong
 * architecture prints nothing or fails to exec. Deliberately NOT `version` —
 * that subcommand only exists from 0.2.0, and the 0.1.x binaries still in the
 * field are perfectly good tunnels.
 *
 * Memoised per path+mtime+size: this is on the path of every install check, and
 * the answer only changes when the file does.
 */
const runsCache = new Map();
export function binaryRuns(bin) {
  let key;
  try {
    const st = statSync(bin);
    key = `${bin}:${st.mtimeMs}:${st.size}`;
  } catch {
    return false;
  }
  const hit = runsCache.get(key);
  if (hit !== undefined) return hit;
  let ok = false;
  try {
    const r = spawnSync(bin, [], { encoding: "utf8", timeout: 5000 });
    ok = !r.error && `${r.stdout || ""}${r.stderr || ""}`.includes("serve");
  } catch {
    ok = false;
  }
  runsCache.set(key, ok);
  return ok;
}

// --- what have we got? ---------------------------------------------------------

/** The stamp we wrote when we installed, or null. */
export function tunnelMeta() {
  try {
    return JSON.parse(readFileSync(path.join(BIN_DIR, META_NAME), "utf8"));
  } catch {
    return null;
  }
}

/**
 * What this machine's tunnel actually is.
 *
 * Asks the binary first — it is the only thing that knows for certain, and a
 * hand-placed POUNCE_TUNNEL_BIN dev build has no stamp to read. Falls back to
 * the stamp, which covers the binaries already in the field: `version` did not
 * exist before 0.2.0, so on those the call fails and the stamp is all there is.
 * `unknown` is a real, expected answer and the fleet view has to render it.
 */
export function tunnelVersion() {
  const bin = tunnelBinary();
  if (!bin) return null;
  try {
    const r = spawnSync(bin, ["version", "--json"], { encoding: "utf8", timeout: 5_000 });
    if (r.status === 0 && r.stdout) {
      const { version, proto } = JSON.parse(r.stdout);
      if (version) return { version, proto: proto ?? null, source: "binary" };
    }
  } catch {
    // Too old to answer, or not runnable here. The stamp is the fallback.
  }
  const meta = tunnelMeta();
  if (meta?.version) return { version: meta.version, proto: meta.proto ?? null, source: "stamp" };
  return { version: null, proto: null, source: "unknown" };
}

let inFlight = null;
let lastError = null;

/** Why the last ensure failed, for whoever has to explain it. */
export function lastTunnelError() {
  return lastError;
}

/**
 * Order two tunnel versions. `0.10.0` above `0.9.0`; an unknown side lowest.
 *
 * The numbers are compared as numbers, because as text `"0.10.0" < "0.9.0"` and
 * a fleet a release behind would report itself up to date.
 *
 * A prerelease sorts BELOW the release it leads to, per semver — `0.2.0-rc1` is
 * older than `0.2.0`, not newer for having more characters. Get that backwards
 * and cutting an rc pins every machine to it: nothing would ever look newer, so
 * nothing would ever offer to update.
 */
export function compareVersions(a, b) {
  if (a === b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  const split = (v) => {
    const [core, ...pre] = String(v).split("-");
    return { core: core.split(".").map(Number), pre: pre.join("-") };
  };
  const [x, y] = [split(a), split(b)];
  for (let i = 0; i < Math.max(x.core.length, y.core.length); i++) {
    const [p, q] = [x.core[i] ?? 0, y.core[i] ?? 0];
    if (Number.isNaN(p) || Number.isNaN(q)) break; // not a number we can rank
    if (p !== q) return p < q ? -1 : 1;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1; // a release beats its own prerelease
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/**
 * Return the path to a usable `pounce-tunnel`, downloading it if this machine
 * hasn't got one. Returns null when we couldn't get it — {@link lastTunnelError}
 * then says why.
 *
 * Single-flighted: several peers dialled at once must not race on the same
 * temp dir and the same destination file.
 */
export async function ensureTunnelBinary() {
  const have = tunnelBinary();
  // A file at the path is not a tunnel. An update that was rolled back can leave
  // a stub behind, and a binary copied from another machine can be the wrong
  // arch — both exist, so both used to end this function right here, and no
  // amount of re-running the installer would ever replace them. Treating an
  // unusable binary as absent is what makes off-LAN self-heal.
  if (have && binaryRuns(have)) return have;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const { path: dest } = await fetchTunnel();
      lastError = null;
      return dest;
    } catch (e) {
      lastError = String(e?.message || e);
      return null;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/**
 * Download the newest build and put it in place, replacing whatever is there.
 *
 * Three things make this different from "download a file":
 *
 * The digest is checked before the binary is allowed anywhere near BIN_DIR. We
 * are handing this process control of the machine's networking; GitHub over TLS
 * is good, and verifying what came back is better.
 *
 * The swap is a rename within one directory, so the path is never briefly
 * missing or half-written — a dial landing mid-update gets the old binary or
 * the new one, never a truncated one. The running `serve` keeps its own inode
 * and carries on until it is deliberately restarted.
 *
 * The binary it replaces is kept as `.prev`. On a remote server this update is
 * arriving THROUGH the tunnel it is replacing, and if the new one won't run
 * there may be no second way in — so the thing that worked five seconds ago
 * stays on disk. {@link rollbackTunnel} puts it back.
 */
export async function fetchTunnel() {
  const triple = rustTriple();
  if (!triple) throw new Error(`no tunnel build for ${process.platform}/${process.arch}`);
  const release = await latestTunnelRelease(triple);
  if (!release?.url) throw new Error(`no ${wantedAsset(triple)} on any tunnel-v* release`);

  const res = await fetch(release.url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`download -> ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());

  if (release.digest) {
    const got = `sha256:${createHash("sha256").update(buf).digest("hex")}`;
    if (got !== release.digest) {
      throw new Error(`digest mismatch: release says ${release.digest}, download is ${got}`);
    }
  }

  let tmp = null;
  try {
    tmp = mkdtempSync(path.join(os.tmpdir(), "pounce-tunnel-"));
    const src = extractInto(buf, tmp);
    mkdirSync(BIN_DIR, { recursive: true });
    const dest = path.join(BIN_DIR, BIN_NAME);
    // Stage INSIDE BIN_DIR: rename is only atomic within a filesystem, and
    // os.tmpdir() is routinely a different one (the EXDEV this used to dodge
    // with a plain copy, which is exactly the non-atomic write we can't have).
    const staged = path.join(BIN_DIR, `.${BIN_NAME}.incoming`);
    copyFileSync(src, staged);
    chmodSync(staged, 0o755);
    if (existsSync(dest)) {
      try {
        copyFileSync(dest, path.join(BIN_DIR, PREV_NAME));
      } catch {
        // No previous copy is a worse position to update from, not a reason to
        // refuse — a machine with no tunnel at all has nothing to roll back to.
      }
    }
    renameSync(staged, dest);
    writeFileSync(
      path.join(BIN_DIR, META_NAME),
      `${JSON.stringify(
        {
          tag: release.tag,
          version: release.version,
          proto: null, // filled in below, once the binary can be asked
          triple,
          digest: release.digest,
          url: release.url,
          installedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
    );
    // Now that it's in place, let it say what it is — and correct the stamp if
    // it disagrees with the tag we downloaded it under.
    const actual = tunnelVersion();
    if (actual?.source === "binary") {
      const meta = tunnelMeta() ?? {};
      writeFileSync(
        path.join(BIN_DIR, META_NAME),
        `${JSON.stringify({ ...meta, version: actual.version, proto: actual.proto }, null, 2)}\n`,
      );
    }
    return { path: dest, version: actual?.version ?? release.version, tag: release.tag };
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}

/** Put back the binary the last update replaced. Returns false when there is
 *  nothing to go back to. */
export function rollbackTunnel() {
  const prev = path.join(BIN_DIR, PREV_NAME);
  const dest = path.join(BIN_DIR, BIN_NAME);
  if (!existsSync(prev)) return false;
  try {
    copyFileSync(prev, `${dest}.restoring`);
    chmodSync(`${dest}.restoring`, 0o755);
    renameSync(`${dest}.restoring`, dest);
    rmSync(prev, { force: true });
    // The stamp described the binary we just removed. Re-derive it rather than
    // leaving a version number that is now a lie.
    const actual = tunnelVersion();
    const meta = tunnelMeta() ?? {};
    writeFileSync(
      path.join(BIN_DIR, META_NAME),
      `${JSON.stringify(
        {
          ...meta,
          version: actual?.version ?? null,
          proto: actual?.proto ?? null,
          rolledBackAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
    );
    return true;
  } catch {
    return false;
  }
}

// --- is the tunnel actually UP? ------------------------------------------------
// A binary on disk is not a tunnel. This module's `tunnelBinary()` answers "have
// we got one", and everything that reported off-LAN readiness used to stop
// there — doctor's `tunnel.ok`, /ui, the pairing QR. That is how a `serve` that
// died on every spawn went unnoticed for days: the file existed, so every
// surface said "internet", while the phone off Wi-Fi could reach nothing.
//
// So whoever RUNS serve (the bridge's ensureTunnel) reports what happened, and
// the readiness surfaces read that instead of stat()ing a file.
//
// `known: false` is the important third state: a doctor run outside the bridge,
// or a dev bridge that never starts a tunnel, has nobody to report — there we
// fall back to the binary check rather than claiming a tunnel is down when we
// simply never looked.
let serveState = { known: false, up: false, error: null };

/** Called by the process that supervises `serve`. */
export function reportServeState({ up, error = null }) {
  serveState = { known: true, up: !!up, error: up ? null : error };
}

/** What we know about `serve` on this machine right now. */
export function serveHealth() {
  return serveState;
}

/** Test seam. */
export function _resetServeState() {
  serveState = { known: false, up: false, error: null };
}
