#!/usr/bin/env node
/**
 * `npx use-pounce` — pair your phone with this machine in one command.
 *
 * Starts the Pounce bridge in the background (or reuses a running one), makes
 * sure the pounce-tunnel binary is installed so pairing works from ANY network
 * (the phone dials an iroh p2p tunnel by node id — no port-forwarding, works
 * on a machine you're SSH'd into), prints the pairing QR in the terminal, and
 * waits for the phone to connect. The bridge keeps running after exit.
 *
 *   pounce            start + QR + wait for the phone
 *   pounce qr         start + QR, don't wait
 *   pounce status     bridge/tunnel/phone status
 *   pounce stop       stop the background bridge (and its tunnel)
 *   pounce logs [-f]  show the bridge log
 *
 *   --port <n>     bridge port (default 8099)
 *   --token <t>    pairing token (default: random, persisted in ~/.pounce)
 *   --lan          skip the tunnel — QR pairs on this Wi-Fi only
 *   --foreground   run the bridge attached to this terminal instead
 */
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import qrcode from "qrcode-terminal";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(readFileSync(path.join(HERE, "..", "package.json"), "utf8"));
const IS_WIN = process.platform === "win32";

const POUNCE_DIR = path.join(os.homedir(), ".pounce");
const BIN_DIR = path.join(POUNCE_DIR, "bin");
const LOG_FILE = path.join(POUNCE_DIR, "bridge.log");
// { pid, port, startedAt } — per port, so a --port test bridge never clobbers
// the default one's stop/status bookkeeping.
const metaFile = (port) => path.join(POUNCE_DIR, `cli-bridge-${port}.json`);
const TOKEN_FILE = path.join(POUNCE_DIR, "cli-token");
const TUNNEL_BIN =
  process.env.POUNCE_TUNNEL_BIN ||
  path.join(BIN_DIR, IS_WIN ? "pounce-tunnel.exe" : "pounce-tunnel");

// Where tunnel binaries are published: GitHub release tagged tunnel-v*, one
// pounce-tunnel-<rust-triple>.tar.gz per platform. POUNCE_TUNNEL_URL overrides
// with a direct asset URL.
const RELEASES_API = "https://api.github.com/repos/pounce-ai/pounce/releases?per_page=30";

// The bundled bridge (published package); falls back to the unbundled source
// when running from the monorepo before a build.
const LAUNCHER = [
  path.join(HERE, "..", "dist", "launcher.mjs"),
  path.join(HERE, "..", "src", "launcher-entry.mjs"),
].find(existsSync);

// --- tiny terminal helpers ----------------------------------------------------
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = (s) => c(1, s);
const dim = (s) => c(2, s);
const green = (s) => c(32, s);
const yellow = (s) => c(33, s);
const red = (s) => c(31, s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, { timeoutMs = 3000, token = null } = {}) {
  const headers = { "user-agent": `use-pounce/${PKG.version}` };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers });
  if (!res.ok) {
    const e = new Error(`${url} -> ${res.status}`);
    e.status = res.status;
    throw e;
  }
  return res.json();
}

// --- bridge lifecycle ---------------------------------------------------------
async function bridgeAlive(port) {
  try {
    return (await getJson(`http://127.0.0.1:${port}/health`, { timeoutMs: 900 })).ok === true;
  } catch {
    return false;
  }
}

/** Loopback-only status surface; exposes the running bridge's actual token. */
function uiInfo(port) {
  return getJson(`http://127.0.0.1:${port}/ui`, { timeoutMs: 3000 });
}

/** The token a bridge WE start will use: --token, else BRIDGE_TOKEN, else a
 *  random one minted once per machine. A well-known default would let anyone
 *  who learns the tunnel node id connect — bad for the SSH/remote use case. */
function effectiveToken(opts) {
  if (opts.token) return opts.token;
  if (process.env.BRIDGE_TOKEN) return process.env.BRIDGE_TOKEN;
  try {
    const t = readFileSync(TOKEN_FILE, "utf8").trim();
    if (t) return t;
  } catch {}
  const t = crypto.randomBytes(12).toString("base64url");
  mkdirSync(POUNCE_DIR, { recursive: true });
  writeFileSync(TOKEN_FILE, `${t}\n`, { mode: 0o600 });
  return t;
}

function daemonMeta(port) {
  try {
    return JSON.parse(readFileSync(metaFile(port), "utf8"));
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function startDaemon({ port, token, foreground }) {
  if (!LAUNCHER)
    throw new Error(
      "bridge launcher missing — run `bun run build` in apps/cli (or reinstall the package)",
    );
  mkdirSync(POUNCE_DIR, { recursive: true });
  const env = {
    ...process.env,
    BRIDGE_PORT: String(port),
    BRIDGE_TOKEN: token,
    POUNCE_CLI_VERSION: PKG.version,
  };
  if (foreground) {
    const child = spawn(process.execPath, [LAUNCHER], { env, stdio: "inherit" });
    child.on("exit", (code) => process.exit(code ?? 0));
    return null; // never returns to the pairing flow — the bridge owns the terminal
  }
  const log = openSync(LOG_FILE, "a");
  const child = spawn(process.execPath, [LAUNCHER], {
    env,
    detached: true,
    stdio: ["ignore", log, log],
    windowsHide: true,
  });
  child.unref();
  writeFileSync(
    metaFile(port),
    JSON.stringify({ pid: child.pid, port, startedAt: new Date().toISOString() }, null, 2),
  );
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await bridgeAlive(port)) return child.pid;
    if (child.exitCode != null) break;
    await sleep(250);
  }
  throw new Error(`bridge didn't come up on port ${port} — see ${LOG_FILE}`);
}

// --- tunnel binary ------------------------------------------------------------
function rustTriple() {
  const arch = { arm64: "aarch64", x64: "x86_64" }[process.arch];
  const osPart = { darwin: "apple-darwin", linux: "unknown-linux-gnu", win32: "pc-windows-msvc" }[
    process.platform
  ];
  return arch && osPart ? `${arch}-${osPart}` : null;
}

/** Make sure ~/.pounce/bin/pounce-tunnel exists, downloading a platform build
 *  from the GitHub release when missing. Returns "present" | "downloaded" |
 *  a `{ skipped: reason }` — pairing continues LAN-only on skip. */
async function ensureTunnelBinary(opts) {
  if (existsSync(TUNNEL_BIN)) return "present";
  if (opts.lan) return { skipped: "--lan" };
  const triple = rustTriple();
  if (!triple) return { skipped: `no tunnel build for ${process.platform}/${process.arch}` };
  try {
    let assetUrl = process.env.POUNCE_TUNNEL_URL || null;
    if (!assetUrl) {
      const releases = await getJson(RELEASES_API, { timeoutMs: 10_000 });
      const wanted = `pounce-tunnel-${triple}${IS_WIN ? ".zip" : ".tar.gz"}`;
      for (const r of releases) {
        if (!r.tag_name?.startsWith("tunnel-v")) continue;
        const asset = (r.assets || []).find((a) => a.name === wanted);
        if (asset) {
          assetUrl = asset.browser_download_url;
          break;
        }
      }
      if (!assetUrl) return { skipped: `no ${wanted} on any tunnel-v* release yet` };
    }
    process.stdout.write(dim(`  downloading the remote-access component (${triple})…\n`));
    const res = await fetch(assetUrl, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`download -> ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const tmp = mkdtempSync(path.join(os.tmpdir(), "pounce-tunnel-"));
    try {
      const archive = path.join(tmp, IS_WIN ? "t.zip" : "t.tar.gz");
      writeFileSync(archive, buf);
      const r = IS_WIN
        ? spawnSync("tar", ["-xf", archive, "-C", tmp]) // bsdtar ships with Win10+
        : spawnSync("tar", ["xzf", archive, "-C", tmp]);
      if (r.status !== 0) throw new Error("extract failed");
      const name = IS_WIN ? "pounce-tunnel.exe" : "pounce-tunnel";
      const found = readdirSync(tmp, { recursive: true }).find(
        (f) => path.basename(String(f)) === name,
      );
      if (!found) throw new Error(`${name} not in archive`);
      mkdirSync(BIN_DIR, { recursive: true });
      const src = path.join(tmp, String(found));
      // copy, not rename — os.tmpdir() can be a different filesystem (EXDEV)
      copyFileSync(src, TUNNEL_BIN);
      chmodSync(TUNNEL_BIN, 0o755);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    return "downloaded";
  } catch (e) {
    return { skipped: `download failed (${e?.message || e})` };
  }
}

/** Poll the bridge until its tunnel is up and has an identity. Also (re)spawns
 *  the tunnel on bridges that started before the binary was installed.
 *  Resolves { tunnel, why } — `why` explains a null tunnel when known. */
async function waitForTunnel(port, token, { timeoutMs = 25_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let legacy = false;
  while (Date.now() < deadline) {
    try {
      if (!legacy) {
        const r = await getJson(`http://127.0.0.1:${port}/v1/tunnel/ensure`, { token });
        if (r.eligible === false)
          return { tunnel: null, why: "the machine's tunnel serves the default port (8099) only" };
        if (r.running && r.tunnel?.nodeId) return { tunnel: r.tunnel, why: null };
        if (!r.binary) return { tunnel: null, why: "bridge found no tunnel binary" };
      } else {
        // Bridge predates /v1/tunnel/ensure — /v1/pair still serves a stored
        // identity (can't confirm the tunnel process, so trust the file). Only
        // on the default port: the identity always targets the default bridge.
        if (port !== 8099)
          return { tunnel: null, why: "the machine's tunnel serves the default port (8099) only" };
        const r = await getJson(`http://127.0.0.1:${port}/v1/pair`, { token });
        if (r.pairing?.nodeId)
          return { tunnel: { nodeId: r.pairing.nodeId, relay: r.pairing.relay }, why: null };
      }
    } catch (e) {
      if (e?.status === 404) {
        legacy = true;
        continue;
      }
      if (e?.status === 401)
        throw new Error(
          "running bridge rejected our token — is another Pounce bridge configured differently?",
        );
    }
    await sleep(600);
  }
  return {
    tunnel: null,
    why: `didn't come up in ${Math.round(timeoutMs / 1000)}s — see ${LOG_FILE}`,
  };
}

// --- pairing UI ---------------------------------------------------------------
function deepLink({ pairUrl, token, tunnel }) {
  let link = `pounce://connect?url=${encodeURIComponent(pairUrl)}&token=${encodeURIComponent(token)}`;
  if (tunnel?.nodeId) {
    link += `&node=${encodeURIComponent(tunnel.nodeId)}&host=${encodeURIComponent(os.hostname().replace(/\.local$/, ""))}`;
    if (tunnel.relay) link += `&relay=${encodeURIComponent(tunnel.relay)}`;
  }
  return link;
}

async function waitForPhone(port) {
  for (;;) {
    try {
      const ui = await uiInfo(port);
      // "Fresh" activity only — a phone that synced before we launched
      // shouldn't count as this scan succeeding.
      if (ui.lastSeenMsAgo != null && ui.lastSeenMsAgo < 5000) return;
    } catch {}
    await sleep(1500);
  }
}

// --- commands -----------------------------------------------------------------
function printPairing(pairUrl, token, tunnel) {
  const link = deepLink({ pairUrl, token, tunnel });
  console.log(
    `\n  ${bold("Scan with the Pounce app")} ${dim("(Settings → Scan QR)")} ${bold("or your camera:")}\n`,
  );
  qrcode.generate(link, { small: true });
  console.log(`\n  ${dim("or open on the phone:")}\n  ${dim(link)}\n`);
}

async function cmdUp(opts, { wait }) {
  console.log(`\n${bold("🐾 Pounce")} ${dim(`v${PKG.version}`)} — pair your phone\n`);

  let reused = false;
  let pid = null;
  if (await bridgeAlive(opts.port)) {
    reused = true;
  } else {
    pid = await startDaemon({
      port: opts.port,
      token: effectiveToken(opts),
      foreground: opts.foreground,
    });
    if (opts.foreground) return; // bridge owns the terminal now
  }

  // Trust the RUNNING bridge's own state (its token may predate this run —
  // e.g. the desktop app's bridge or an earlier launchd install).
  const ui = await uiInfo(opts.port);
  const token = ui.token;
  const pairUrl = ui.pairUrl || `http://127.0.0.1:${opts.port}`;
  console.log(
    `  ${dim("bridge")}  ${pairUrl}  ${dim(reused ? "(already running)" : `(started · pid ${pid} · logs: pounce logs)`)}`,
  );

  // ONE code, shown as fast as possible. The remote identity is stable across
  // restarts, so on any machine that has run before /ui already carries it and
  // the QR is remote-capable instantly. Only a machine's very first run holds
  // the QR briefly while remote access is minted — never a second code; if
  // remote isn't ready in time, the LAN code still upgrades the phone to
  // remote automatically after it pairs (the app captures /v1/pair on connect).
  let tunnel = ui.tunnel?.nodeId ? ui.tunnel : null;
  let remoteNote = null;
  if (!tunnel && !opts.lan) {
    console.log(`  ${dim("Setting up remote access… (first run only — takes a few seconds)")}`);
    const state = await ensureTunnelBinary(opts);
    if (state.skipped) {
      remoteNote = `${yellow("!")} Pairs over your Wi-Fi for now ${dim(`(remote access unavailable: ${state.skipped})`)}`;
    } else {
      tunnel = (await waitForTunnel(opts.port, token)).tunnel;
      if (!tunnel) {
        remoteNote = `${yellow("!")} Pairs over your Wi-Fi for now — remote access is still warming up and will switch on automatically after you pair`;
      }
    }
  }
  printPairing(pairUrl, token, tunnel);

  if (opts.lan) {
    console.log(
      `  ${dim("Wi-Fi-only mode (--lan): scan while on the same network as this machine")}`,
    );
  } else if (tunnel) {
    // Confirm the remote link quietly; the code on screen never changes (the
    // identity is stable) — this only decides which status line to show.
    const r = await waitForTunnel(opts.port, token, { timeoutMs: 12_000 });
    console.log(
      r.tunnel
        ? `  ${green("✓")} Works from anywhere — Wi-Fi at home, an encrypted tunnel everywhere else`
        : `  ${yellow("!")} Pairs over your Wi-Fi for now — the remote link is reconnecting in the background`,
    );
  } else if (remoteNote) {
    console.log(`  ${remoteNote}`);
  }

  if (!wait) return;
  console.log(
    `  Waiting for your phone… ${dim("(Ctrl-C is safe — the bridge keeps running; `pounce stop` stops it)")}`,
  );
  await waitForPhone(opts.port);
  console.log(`\n  ${green("✓ Phone connected")} — you're all set.\n`);
  process.exit(0); // detached daemon keeps the event loop alive otherwise
}

async function cmdStatus(opts) {
  const alive = await bridgeAlive(opts.port);
  if (!alive) {
    console.log(
      `bridge: ${red("not running")} on port ${opts.port} ${dim(`(run \`pounce\` to start it)`)}`,
    );
    return;
  }
  const ui = await uiInfo(opts.port);
  const meta = daemonMeta(opts.port);
  const mine = meta && meta.port === opts.port && pidAlive(meta.pid);
  console.log(
    `bridge: ${green("running")} on ${ui.pairUrl}${mine ? dim(` (pid ${meta.pid})`) : dim(" (not started by this CLI)")}`,
  );
  console.log(
    `tunnel: ${ui.tunnel?.nodeId ? green(`ready (${ui.tunnel.nodeId.slice(0, 12)}…)`) : yellow("off — LAN only")}`,
  );
  console.log(
    `phone:  ${ui.connected ? green(`connected (${ui.devices || 1} device${(ui.devices || 1) === 1 ? "" : "s"})`) : dim("not connected")}`,
  );
}

async function cmdStop(opts) {
  const meta = daemonMeta(opts.port);
  const alive = await bridgeAlive(opts.port);
  if (meta && pidAlive(meta.pid)) {
    process.kill(meta.pid, "SIGTERM"); // its handler reaps the tunnel too
    const deadline = Date.now() + 5000;
    while (pidAlive(meta.pid) && Date.now() < deadline) await sleep(150);
    rmSync(metaFile(opts.port), { force: true });
    console.log(pidAlive(meta.pid) ? red(`pid ${meta.pid} didn't exit`) : green("bridge stopped"));
  } else if (alive) {
    console.log(
      yellow(
        "a bridge is running, but it wasn't started by this CLI (desktop app or launchd?) — not touching it",
      ),
    );
    return;
  } else {
    console.log(dim("bridge isn't running"));
  }
  // Orphaned tunnels squat the iroh identity — sweep them. Only when stopping
  // the default-port bridge: that's the one the tunnel singleton belongs to.
  if (!IS_WIN && opts.port === 8099)
    spawnSync("pkill", ["-f", "pounce-tunnel serve"], { stdio: "ignore" });
}

function cmdLogs(opts) {
  if (!existsSync(LOG_FILE)) {
    console.log(dim(`no log yet at ${LOG_FILE}`));
    return;
  }
  if (opts.follow && !IS_WIN) {
    spawn("tail", ["-n", "40", "-f", LOG_FILE], { stdio: "inherit" });
    return;
  }
  const lines = readFileSync(LOG_FILE, "utf8").split("\n");
  console.log(lines.slice(-40).join("\n"));
}

// --- arg parsing --------------------------------------------------------------
function parseArgs(argv) {
  const opts = {
    port: Number(process.env.BRIDGE_PORT || 8099),
    token: null,
    lan: false,
    foreground: false,
    follow: false,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") opts.port = Number(argv[++i]);
    else if (a === "--token") opts.token = argv[++i];
    else if (a === "--lan") opts.lan = true;
    else if (a === "--foreground") opts.foreground = true;
    else if (a === "--follow" || a === "-f") opts.follow = true;
    else if (a === "--help" || a === "-h") rest.unshift("help");
    else if (a === "--version" || a === "-V") rest.unshift("version");
    else rest.push(a);
  }
  return { opts, cmd: rest[0] || "up" };
}

const HELP = `
${bold("pounce")} — pair your phone with this machine ${dim(`(use-pounce v${PKG.version})`)}

  ${bold("pounce")}            start the bridge (background) + show the pairing QR + wait
  ${bold("pounce qr")}         same, but don't wait for the phone
  ${bold("pounce status")}     bridge / tunnel / phone status
  ${bold("pounce stop")}       stop the background bridge and its tunnel
  ${bold("pounce logs")} [-f]  show (or follow) the bridge log

  --port <n>      bridge port                      ${dim("(default 8099)")}
  --token <t>     pairing token                    ${dim("(default: random, kept in ~/.pounce)")}
  --lan           skip the iroh tunnel — QR works on this Wi-Fi only
  --foreground    run the bridge attached to this terminal

Off-LAN pairing rides an iroh p2p tunnel (no port-forwarding): scan the QR
from anywhere — including a machine you're SSH'd into — and the phone
connects. The bridge keeps running after you close the terminal.
`;

const { opts, cmd } = parseArgs(process.argv.slice(2));
if (!Number.isInteger(opts.port) || opts.port <= 0 || opts.port > 65535) {
  console.error(red("invalid --port"));
  process.exit(2);
}

try {
  if (cmd === "up") await cmdUp(opts, { wait: true });
  else if (cmd === "qr") await cmdUp(opts, { wait: false });
  else if (cmd === "status") await cmdStatus(opts);
  else if (cmd === "stop") await cmdStop(opts);
  else if (cmd === "logs") cmdLogs(opts);
  else if (cmd === "version") console.log(PKG.version);
  else if (cmd === "help") console.log(HELP);
  else {
    console.error(red(`unknown command: ${cmd}`));
    console.log(HELP);
    process.exit(2);
  }
} catch (e) {
  console.error(`\n${red("✗")} ${e?.message || e}`);
  process.exit(1);
}
