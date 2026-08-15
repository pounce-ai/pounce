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
 *   pounce configure  detect this machine, then install the app or the bridge
 *   pounce mcp        serve this machine's agent history over MCP (stdio)
 *   pounce status     bridge/tunnel/phone status
 *   pounce stop       stop the background bridge (and its tunnel)
 *   pounce logs [-f]  show the bridge log

 *
 *   pounce peers            machines nearby, who is asking, who has access
 *   pounce ask <machine>    ask another computer to share its threads
 *   pounce approve <code>   let a machine in (--spaces a,b --hours 8 --forever)
 *   pounce deny <code>      turn a request down
 *   pounce revoke <id>      take access away again
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
import { fileURLToPath, pathToFileURL } from "node:url";
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

// --- sharing with other machines -------------------------------------------------
// The same handshake the /peers page runs, for boxes with no browser: a server
// you SSH into, or any machine where the desktop app (macOS-only) isn't an
// option. Every call goes to the local bridge, which does the talking to peers.

/** Authenticated call to OUR bridge. Fails with a clear line rather than a
 *  stack when the bridge isn't up — that is the common case, not an error. */
async function bridge(port, path, { method = "GET", body = null } = {}) {
  let token;
  try {
    token = (await uiInfo(port)).token;
  } catch {
    throw new Error(`no bridge on port ${port} — run ${bold("pounce")} first`);
  }
  // Built rather than spread with an undefined body: a GET carrying a `body`
  // key is invalid even when the value is undefined.
  const init = {
    method,
    signal: AbortSignal.timeout(20_000),
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": `use-pounce/${PKG.version}`,
    },
  };
  if (body) init.body = JSON.stringify(body);
  const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || `${path} -> ${res.status}`);
  return out;
}

function fmtCode(c) {
  return c ? `${c.slice(0, 3)}-${c.slice(3)}` : "";
}
function timeLeft(iso) {
  if (!iso) return "no expiry";
  const m = Math.round((Date.parse(iso) - Date.now()) / 60000);
  if (m <= 0) return "expired";
  if (m < 60) return `${m}m left`;
  if (m < 2880) return `${Math.round(m / 60)}h left`;
  return `${Math.round(m / 1440)}d left`;
}
function scopeText(sc) {
  if (!sc || sc.kind === "full") return "everything";
  const bits = [];
  if (sc.repoKeys?.length) bits.push(sc.repoKeys.join(", "));
  if (sc.threads?.length)
    bits.push(`${sc.threads.length} thread${sc.threads.length === 1 ? "" : "s"}`);
  return bits.join(" + ") || "nothing";
}

/** Resolve what the user typed — a hostname, an address, or a full URL — against
 *  the machines we can actually see. Naming one that isn't there is a mistake
 *  worth catching before we start a handshake with it. */
async function resolvePeer(port, who) {
  const { peers } = await bridge(port, "/v1/peers");
  if (!who) return { peers, peer: null };
  const hit = peers.find(
    (p) =>
      p.hostName === who ||
      p.address === who ||
      p.url === who ||
      p.hostName.toLowerCase().startsWith(who.toLowerCase()),
  );
  if (hit) return { peers, peer: hit };
  if (/^https?:\/\//.test(who)) return { peers, peer: { hostName: who, url: who } };
  throw new Error(`no machine called "${who}" nearby — run ${bold("pounce peers")} to see them`);
}

async function cmdPeers(opts) {
  // `pounce peers --visible on|off` flips it and then shows the list, so the
  // state and the way to change it live in one command.
  if (opts.visible !== null) {
    const enabled = /^(on|yes|true|1)$/i.test(opts.visible);
    const r = await bridge(opts.port, "/v1/peers/discovery", { method: "POST", body: { enabled } });
    console.log(
      `${green("\u2713")} ${
        r.discovery.on
          ? "other computers here can now find this one"
          : "this computer is hidden again"
      }`,
    );
  }

  const [peersRes, access, granted] = await Promise.all([
    bridge(opts.port, "/v1/peers"),
    bridge(opts.port, "/v1/access"),
    bridge(opts.port, "/v1/peers/granted"),
  ]);
  const { peers } = peersRes;
  const disc = peersRes.discovery || {};

  if (access.pending.length) {
    console.log(`\n${bold("Waiting on you")}`);
    for (const r of access.pending) {
      const what =
        r.kind === "preview" ? "a look at what's here" : `read access (${scopeText(r.scope)})`;
      console.log(`  ${bold(r.requester.hostName)} wants ${what}   ${dim(fmtCode(r.code))}`);
      if (r.note) console.log(`    ${dim(`"${r.note}"`)}`);
      console.log(`    ${dim(`pounce approve ${r.code}`)}   ${dim(`pounce deny ${r.code}`)}`);
    }
  }

  // This computer first, then the list — which is populated whether or not this
  // one is visible, so visibility is reported as a fact about THIS machine
  // rather than as a precondition for seeing anything.
  console.log(`\n${bold("This computer")}`);
  if (!disc.eligible) {
    console.log(dim("  can't be made visible here"));
  } else if (!disc.on) {
    console.log(dim("  hidden — it won't appear in anyone else's list"));
    console.log(
      disc.locked
        ? dim("  (set on this machine, in the bridge's environment)")
        : `  ${bold("pounce peers --visible on")}${dim("  to let computers here find it")}`,
    );
  } else {
    console.log(dim("  visible — computers here can see its name and ask for access"));
  }

  console.log(`\n${bold("Machines on this network")}`);
  if (!peers.length) {
    console.log(dim("  nothing yet — the other computer needs Pounce running and visible"));
  }
  for (const p of peers) {
    console.log(`  ${bold(p.hostName)}  ${dim(`${p.address}:${p.port}`)}`);
    console.log(`    ${dim(`pounce ask ${p.hostName}`)}`);
  }

  console.log(`\n${bold("Access you hold")}`);
  if (!granted.held.length) console.log(dim("  none"));
  for (const g of granted.held) {
    console.log(
      `  ${bold(g.hostName || g.url)}  ${dim(`${scopeText(g.scope)} · ${timeLeft(g.expiresAt)}`)}`,
    );
  }

  console.log(`\n${bold("Machines with access to this one")}`);
  if (!access.grants.length) console.log(dim("  none"));
  for (const g of access.grants) {
    const what = g.kind === "preview" ? "browsing names" : g.summary;
    console.log(`  ${bold(g.requester.hostName)}  ${dim(`${what} · ${timeLeft(g.expiresAt)}`)}`);
    console.log(`    ${dim(`pounce revoke ${g.id.slice(0, 8)}`)}`);
  }
  console.log();
}

/** Poll one of our asks until the person at the other end answers. */
async function waitForAnswer(port, ask, what) {
  process.stdout.write(`\n${bold(`Asking ${ask.hostName} for ${what}`)}\n`);
  console.log(`  Approve it on that machine. Check the code matches: ${bold(fmtCode(ask.code))}\n`);
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const r = await bridge(port, `/v1/peers/ask/${ask.requestId}`).catch(() => null);
    if (!r || r.state === "pending") continue;
    if (r.state === "approved") return r;
    throw new Error(`they did not grant access (${r.state})`);
  }
  throw new Error("nobody answered — the request timed out");
}

async function cmdAsk(opts, who) {
  const { peer } = await resolvePeer(opts.port, who);
  if (!peer) throw new Error(`which machine? run ${bold("pounce peers")} to see them`);

  const wantSpaces = opts.spaces
    ? opts.spaces
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  // Reuse a preview we already hold on this machine rather than making its
  // owner approve the same step twice.
  const { held } = await bridge(opts.port, "/v1/peers/granted");
  const have = held.find((h) => h.url === peer.url || h.hostName === peer.hostName);
  let previewGrant = have && have.kind === "preview" ? have.grantId : null;

  if (!previewGrant && !opts.all) {
    const ask = await bridge(opts.port, "/v1/peers/ask", {
      method: "POST",
      body: { peerUrl: peer.url, kind: "preview", note: opts.note },
    });
    const got = await waitForAnswer(
      opts.port,
      { ...ask, hostName: peer.hostName },
      "a look at what's there",
    );
    previewGrant = got.grantId;
  }

  // No spaces named yet: show the catalog and hand back the exact next command.
  if (!wantSpaces.length && !opts.all) {
    const cat = await bridge(opts.port, `/v1/peers/catalog?peer=${encodeURIComponent(peer.url)}`);
    console.log(bold(`${peer.hostName} is showing names and dates only:\n`));
    for (const s of cat.spaces || []) {
      console.log(
        `  ${s.repoKey.padEnd(28)} ${dim(`${s.threadCount} thread${s.threadCount === 1 ? "" : "s"}`)}`,
      );
    }
    console.log(`\nAsk for the ones you want:`);
    console.log(
      `  ${dim(`pounce ask ${peer.hostName} --spaces ${(cat.spaces || [])[0]?.repoKey || "name"}`)}`,
    );
    console.log(
      `  ${dim(`pounce ask ${peer.hostName} --all`)}  ${dim("(everything they'll allow)")}\n`,
    );
    return;
  }

  const ask = await bridge(opts.port, "/v1/peers/ask", {
    method: "POST",
    body: {
      peerUrl: peer.url,
      kind: "read",
      previewGrant,
      note: opts.note,
      scope: opts.all ? { kind: "full" } : { repoKeys: wantSpaces, threads: [] },
    },
  });
  const got = await waitForAnswer(opts.port, { ...ask, hostName: peer.hostName }, "read access");
  console.log(
    `${green("✓")} ${bold(peer.hostName)} granted ${bold(scopeText(got.scope))} · ${timeLeft(got.expiresAt)}\n`,
  );
  console.log(dim(`  Listed under "Access you hold" — see: pounce peers\n`));
}

/** Requests and grants are addressed by their SHORT code or id prefix, because
 *  nobody is going to retype a 32-hex id from a terminal. */
async function findRequest(port, key) {
  const { pending } = await bridge(port, "/v1/access");
  const k = String(key || "").replace(/-/g, "");
  const hit = pending.find((r) => r.code === k || r.id === k || r.id.startsWith(k));
  if (!hit) throw new Error(`no request matching "${key}" — run ${bold("pounce peers")}`);
  return hit;
}

async function cmdApprove(opts, key) {
  const r = await findRequest(opts.port, key);
  const spaces = opts.spaces
    ? opts.spaces
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : null;
  // The owner's choice beats what was asked for; with nothing said, honour the
  // request as it stands.
  const scope =
    r.kind === "preview"
      ? undefined
      : spaces
        ? { repoKeys: spaces, threads: [] }
        : (r.scope ?? { kind: "full" });
  const hours = opts.forever ? null : (opts.hours ?? 24);
  const out = await bridge(opts.port, "/v1/access/approve", {
    method: "POST",
    body: {
      requestId: r.id,
      scope,
      expiresAt:
        r.kind === "preview" || hours === null
          ? null
          : new Date(Date.now() + hours * 3600_000).toISOString(),
    },
  });
  console.log(
    `${green("✓")} ${r.requester.hostName} can read ${bold(out.grant.summary)} · ${timeLeft(out.grant.expiresAt)}`,
  );
}

async function cmdDeny(opts, key) {
  const r = await findRequest(opts.port, key);
  await bridge(opts.port, "/v1/access/deny", { method: "POST", body: { requestId: r.id } });
  console.log(`${green("✓")} denied ${r.requester.hostName}`);
}

async function cmdRevoke(opts, key) {
  const { grants } = await bridge(opts.port, "/v1/access");
  const k = String(key || "");
  const hit = grants.find((g) => g.id === k || g.id.startsWith(k) || g.requester.hostName === k);
  if (!hit) throw new Error(`no grant matching "${key}" — run ${bold("pounce peers")}`);
  await bridge(opts.port, "/v1/access/revoke", { method: "POST", body: { grantId: hit.id } });
  console.log(`${green("✓")} revoked ${hit.requester.hostName}`);
}

function parseArgs(argv) {
  const opts = {
    port: Number(process.env.BRIDGE_PORT || 8099),
    token: null,
    lan: false,
    foreground: false,
    follow: false,
    // Sharing with other machines (see cmdPeers and friends).
    spaces: null,
    hours: null,
    forever: false,
    all: false,
    note: null,
    visible: null,
    // `pounce configure` — which half to install, and whether to ask at all.
    want: null,
    yes: false,
    remove: false,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") opts.port = Number(argv[++i]);
    else if (a === "--token") opts.token = argv[++i];
    else if (a === "--lan") opts.lan = true;
    else if (a === "--foreground") opts.foreground = true;
    else if (a === "--follow" || a === "-f") opts.follow = true;
    else if (a === "--spaces") opts.spaces = argv[++i];
    else if (a === "--hours") opts.hours = Number(argv[++i]);
    else if (a === "--forever") opts.forever = true;
    else if (a === "--all") opts.all = true;
    else if (a === "--note") opts.note = argv[++i];
    else if (a === "--visible" || a === "--discoverable") opts.visible = argv[++i];
    else if (a === "--desktop" || a === "--app") opts.want = "desktop";
    else if (a === "--bridge") opts.want = "bridge";
    else if (a === "--yes" || a === "-y") opts.yes = true;
    else if (a === "--remove" || a === "--uninstall") opts.remove = true;
    else if (a === "--help" || a === "-h") rest.unshift("help");
    else if (a === "--version" || a === "-V") rest.unshift("version");
    else rest.push(a);
  }
  // Positionals past the command: the machine to ask, the request to answer.
  return { opts, cmd: rest[0] || "up", args: rest.slice(1) };
}

const HELP = `
${bold("pounce")} — pair your phone with this machine ${dim(`(use-pounce v${PKG.version})`)}

  ${bold("pounce")}            start the bridge (background) + show the pairing QR + wait
  ${bold("pounce qr")}         same, but don't wait for the phone
  ${bold("pounce configure")}  set this machine up for good — the app, or a bridge that
                    starts at login ${dim("(it works out which ones can run here)")}
  ${bold("pounce status")}     bridge / tunnel / phone status
  ${bold("pounce stop")}       stop the background bridge and its tunnel
  ${bold("pounce logs")} [-f]  show (or follow) the bridge log
  ${bold("pounce mcp")}        serve your agent history to other AI tools over MCP ${dim("(stdio)")}

${bold("Sharing with another computer")} ${dim("— read-only, scoped, and it expires")}

  ${bold("pounce peers")}              who is nearby, who is asking, who has access
  ${bold("pounce ask")} <machine>      ask a machine to share its threads with you
  ${bold("pounce approve")} <code>     let a machine in
  ${bold("pounce deny")} <code>        turn a request down
  ${bold("pounce revoke")} <id|host>   take access away again

  --spaces a,b    limit to these projects          ${dim("(ask + approve)")}
  --all           ask for everything they allow
  --hours <n>     how long the access lasts        ${dim("(default 24; --forever for none)")}
  --note <text>   a line for the person approving
  --visible on|off   let other computers here find this one ${dim("(hidden by default)")}

  Or open ${bold("http://127.0.0.1:8099/peers")} in a browser for the same thing with buttons.

${bold("Setting this machine up")} ${dim("— pounce configure")}

  --desktop       install the desktop app          ${dim("(where it can run)")}
  --bridge        install the background bridge as a login service
  --remove        take that login service back off
  -y, --yes       don't ask — take the recommendation

  --port <n>      bridge port                      ${dim("(default 8099)")}
  --token <t>     pairing token                    ${dim("(default: random, kept in ~/.pounce)")}
  --lan           skip the iroh tunnel — QR works on this Wi-Fi only
  --foreground    run the bridge attached to this terminal

Give any MCP-capable agent your cross-agent history:
  ${dim("claude mcp add pounce -- npx use-pounce mcp")}
Read-only: search history, list threads, read a thread, read your markers.

Off-LAN pairing rides an iroh p2p tunnel (no port-forwarding): scan the QR
from anywhere — including a machine you're SSH'd into — and the phone
connects. The bridge keeps running after you close the terminal.
`;

const { opts, cmd, args } = parseArgs(process.argv.slice(2));
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
  else if (cmd === "peers") await cmdPeers(opts);
  else if (cmd === "ask") await cmdAsk(opts, args[0]);
  else if (cmd === "approve") await cmdApprove(opts, args[0]);
  else if (cmd === "deny") await cmdDeny(opts, args[0]);
  else if (cmd === "revoke") await cmdRevoke(opts, args[0]);
  else if (cmd === "configure" || cmd === "setup") {
    // Lazy for the same reason as `mcp` below: pairing is the hot path and
    // shouldn't load the installer.
    const entry = [
      path.join(HERE, "..", "dist", "configure.mjs"),
      path.join(HERE, "..", "src", "configure.mjs"),
    ].find(existsSync);
    if (!entry) throw new Error("configure missing — run `bun run build` in apps/cli");
    const { runConfigure } = await import(pathToFileURL(entry).href);
    await runConfigure({
      port: opts.port,
      version: PKG.version,
      want: opts.want,
      yes: opts.yes,
      remove: opts.remove,
    });
  } else if (cmd === "mcp") {
    // Import lazily: the MCP SDK is only needed for this one command, and
    // pairing (the hot path) shouldn't pay to load it.
    // dist/ in the published package, src/ when run from the monorepo —
    // same resolution the bridge launcher uses above.
    const mcpEntry = [
      path.join(HERE, "..", "dist", "mcp.mjs"),
      path.join(HERE, "..", "src", "mcp.mjs"),
    ].find(existsSync);
    if (!mcpEntry) throw new Error("mcp server missing — run `bun run build` in apps/cli");
    const { runMcpServer } = await import(pathToFileURL(mcpEntry).href);
    await runMcpServer({ port: opts.port, version: PKG.version });
  } else if (cmd === "version") console.log(PKG.version);
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
