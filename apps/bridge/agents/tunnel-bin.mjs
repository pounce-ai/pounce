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
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const IS_WIN = process.platform === "win32";
const BIN_DIR = path.join(os.homedir(), ".pounce", "bin");
const BIN_NAME = IS_WIN ? "pounce-tunnel.exe" : "pounce-tunnel";

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

/** Where the binary lives if we have it — an explicit override first, so a dev
 *  build or a distro package wins over anything we'd download. */
export function tunnelBinary() {
  const candidates = [process.env.POUNCE_TUNNEL_BIN, path.join(BIN_DIR, BIN_NAME)].filter(Boolean);
  return candidates.find((p) => existsSync(p)) || null;
}

async function findAssetUrl(wanted) {
  if (process.env.POUNCE_TUNNEL_URL) return process.env.POUNCE_TUNNEL_URL;
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
      if (asset) return asset.browser_download_url;
    }
    if (releases.length < 100) return null;
  }
  return null;
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

let inFlight = null;
let lastError = null;

/** Why the last ensure failed, for whoever has to explain it. */
export function lastTunnelError() {
  return lastError;
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
  if (have) return have;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const triple = rustTriple();
    if (!triple) {
      lastError = `no tunnel build for ${process.platform}/${process.arch}`;
      return null;
    }
    const wanted = `pounce-tunnel-${triple}${IS_WIN ? ".zip" : ".tar.gz"}`;
    let tmp = null;
    try {
      const assetUrl = await findAssetUrl(wanted);
      if (!assetUrl) {
        lastError = `no ${wanted} on any tunnel-v* release`;
        return null;
      }
      const res = await fetch(assetUrl, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`download -> ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      tmp = mkdtempSync(path.join(os.tmpdir(), "pounce-tunnel-"));
      const src = extractInto(buf, tmp);
      mkdirSync(BIN_DIR, { recursive: true });
      const dest = path.join(BIN_DIR, BIN_NAME);
      // copy, not rename — os.tmpdir() can be a different filesystem (EXDEV)
      copyFileSync(src, dest);
      chmodSync(dest, 0o755);
      lastError = null;
      return dest;
    } catch (e) {
      lastError = String(e?.message || e);
      return null;
    } finally {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
      inFlight = null;
    }
  })();
  return inFlight;
}
