/**
 * `pounce configure` — work out what this machine is, then set Pounce up on it.
 *
 * Two ways to host your agents, and which one is right depends entirely on the
 * machine you're standing on:
 *
 *   • the desktop app — the whole Pounce UI, with the bridge built in and a
 *     pairing QR in the window. Only where there's a screen to put it on.
 *   • the background bridge — no window, starts at login, restarts on crash.
 *     The right answer for a server you SSH into, and for anyone who just wants
 *     their phone to reach this machine and nothing else.
 *
 * So this command detects the platform (OS, architecture, whether there's a
 * desktop session at all, whether you're on the other end of an SSH pipe),
 * offers only the options that can actually work here, recommends one, and then
 * does the install — download and all. `--desktop` / `--bridge` skip the
 * question for scripts; `--remove` takes the login service back off.
 *
 * Bundled to dist/configure.mjs by scripts/build.mjs and imported lazily by
 * bin/pounce.mjs, so pairing — the hot path — never pays to load any of this.
 */
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, ".."); // dist/.. and src/.. are both the package
const IS_WIN = process.platform === "win32";

const POUNCE_DIR = path.join(os.homedir(), ".pounce");
const APP_DIR = path.join(POUNCE_DIR, "app"); // our own copy of use-pounce, for the service
const DOWNLOADS = path.join(POUNCE_DIR, "downloads");
const TOKEN_FILE = path.join(POUNCE_DIR, "cli-token");
const metaFile = (port) => path.join(POUNCE_DIR, `cli-bridge-${port}.json`);

const RELEASES_API = "https://api.github.com/repos/pounce-ai/pounce/releases?per_page=30";

// --- terminal ----------------------------------------------------------------
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = (s) => c(1, s);
const dim = (s) => c(2, s);
const green = (s) => c(32, s);
const yellow = (s) => c(33, s);
const red = (s) => c(31, s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function out(line = "") {
  console.log(line);
}

async function fetchJson(url, timeoutMs, version) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "user-agent": `use-pounce/${version}`, accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

// --- what is this machine? ----------------------------------------------------

/** First line of a file, or null — /etc/os-release and friends are optional. */
function readMaybe(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function macOsVersion() {
  const r = spawnSync("sw_vers", ["-productVersion"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

function linuxName() {
  const rel = readMaybe("/etc/os-release");
  const m = rel?.match(/^PRETTY_NAME="?([^"\n]+)"?/m);
  return m ? m[1] : "Linux";
}

/**
 * Everything the choice below turns on. `headless` is the load-bearing one: a
 * Linux box with no display server has nowhere to draw a desktop app, and
 * offering one there is how a user ends up installing something they can never
 * open.
 */
export function detectPlatform() {
  const { platform, arch } = process;
  const remote = Boolean(
    process.env.SSH_CONNECTION || process.env.SSH_TTY || process.env.SSH_CLIENT,
  );

  if (platform === "darwin") {
    const version = macOsVersion();
    const major = Number(version?.split(".")[0] || 0);
    return {
      platform,
      arch,
      remote,
      headless: false,
      version,
      label: `macOS${version ? ` ${version}` : ""} · ${arch === "arm64" ? "Apple Silicon" : "Intel"}`,
      // The desktop app is arm64-only (ARCHS = arm64) and targets macOS 14+.
      macTooOld: major > 0 && major < 14,
    };
  }
  if (platform === "win32") {
    return {
      platform,
      arch,
      remote,
      headless: false,
      version: os.release(),
      label: `Windows ${os.release()} · ${arch}`,
    };
  }
  if (platform === "linux") {
    const headless = !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
    return {
      platform,
      arch,
      remote,
      headless,
      version: null,
      label: `${linuxName()} · ${arch}${headless ? dim(" · no desktop session") : ""}`,
    };
  }
  return { platform, arch, remote, headless: true, version: null, label: `${platform} · ${arch}` };
}

const has = (cmd) => spawnSync(IS_WIN ? "where" : "which", [cmd], { stdio: "ignore" }).status === 0;

/** Where an installed desktop app would be sitting, if it is. */
function desktopInstalledAt(det) {
  const candidates =
    det.platform === "darwin"
      ? ["/Applications/Pounce.app", path.join(os.homedir(), "Applications", "Pounce.app")]
      : det.platform === "win32"
        ? [
            path.join(process.env.LOCALAPPDATA || "", "Pounce", "Pounce.exe"),
            path.join(process.env.LOCALAPPDATA || "", "Programs", "Pounce", "Pounce.exe"),
            path.join(process.env.ProgramFiles || "", "Pounce", "Pounce.exe"),
          ]
        : ["/opt/Pounce", path.join(os.homedir(), ".local", "share", "Pounce")];
  return candidates.find((p) => p && existsSync(p)) || null;
}

/**
 * Can the desktop app run here, and which download is it? Returns a `why` when
 * it can't — an unavailable option the user can see the reason for beats an
 * option that quietly isn't listed.
 */
export function desktopOption(det) {
  if (det.platform === "darwin") {
    if (det.arch !== "arm64")
      return { available: false, why: "the Mac app needs Apple Silicon — this is an Intel Mac" };
    if (det.macTooOld) return { available: false, why: "the Mac app needs macOS 14 or later" };
    return { available: true, kind: "dmg", assetName: "Pounce.dmg", tag: "desktop" };
  }
  if (det.platform === "win32") {
    if (det.arch !== "x64")
      return { available: false, why: `no Windows build for ${det.arch} yet` };
    return { available: true, kind: "exe", assetName: "Pounce-Setup-Windows.exe", tag: "app" };
  }
  if (det.platform === "linux") {
    const slug = { x64: "x64", arm64: "arm64" }[det.arch];
    if (!slug) return { available: false, why: `no Linux build for ${det.arch} yet` };
    if (det.headless)
      return { available: false, why: "there's no desktop session on this machine to show it on" };
    return has("dpkg")
      ? { available: true, kind: "deb", assetName: `Pounce-Linux-${slug}.deb`, tag: "app" }
      : {
          available: true,
          kind: "tar",
          assetName: `Pounce-Setup-Linux-${slug}.tar.gz`,
          tag: "app",
        };
  }
  return { available: false, why: `no desktop build for ${det.platform}` };
}

// --- release downloads --------------------------------------------------------

/**
 * Newest release carrying this asset. Two tag families are in play and they are
 * not interchangeable: the Mac app ships from `desktop-v*`, the Windows/Linux
 * app from the plain `v*` releases.
 */
export async function resolveAsset({ assetName, tag }, version) {
  const releases = await fetchJson(RELEASES_API, 15_000, version);
  const wanted = tag === "desktop" ? (t) => t.startsWith("desktop-v") : (t) => /^v\d/.test(t);
  for (const r of releases) {
    if (r.draft || r.prerelease || !wanted(r.tag_name || "")) continue;
    const asset = (r.assets || []).find((a) => a.name === assetName);
    if (asset) return { url: asset.browser_download_url, name: asset.name, tag: r.tag_name };
  }
  throw new Error(`no ${assetName} on any published release yet`);
}

async function download(url, dest) {
  const res = await fetch(url, { signal: AbortSignal.timeout(600_000), redirect: "follow" });
  if (!res.ok) throw new Error(`download -> ${res.status}`);
  const total = Number(res.headers.get("content-length") || 0);
  let seen = 0;
  const body = Readable.fromWeb(res.body);
  body.on("data", (chunk) => {
    seen += chunk.length;
    if (!tty) return;
    const mb = (n) => (n / 1e6).toFixed(1);
    const pct = total ? ` ${Math.round((seen / total) * 100)}%` : "";
    process.stdout.write(
      `\r  ${dim(`downloading… ${mb(seen)}${total ? `/${mb(total)}` : ""} MB${pct}`)}   `,
    );
  });
  mkdirSync(path.dirname(dest), { recursive: true });
  await pipeline(body, createWriteStream(dest));
  if (tty) process.stdout.write("\r\x1b[2K");
  return dest;
}

// --- installing the desktop app ----------------------------------------------

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited ${r.status}`);
  return r;
}

async function installDmg(dmg, { confirm }) {
  const mount = mkdtempSync(path.join(os.tmpdir(), "pounce-dmg-"));
  const appDest = "/Applications/Pounce.app";
  try {
    run("hdiutil", ["attach", dmg, "-nobrowse", "-readonly", "-quiet", "-mountpoint", mount]);
    const src = path.join(mount, "Pounce.app");
    if (!existsSync(src)) throw new Error("Pounce.app not inside the disk image");
    if (existsSync(appDest)) {
      const ok = await confirm(`Replace the copy already in /Applications?`);
      if (!ok) return { installed: false, at: appDest };
      // Stop it first — replacing a running .app underneath itself is how you
      // get a half-updated bundle and a crash on next launch.
      spawnSync("osascript", ["-e", 'tell application "Pounce" to quit'], { stdio: "ignore" });
      await sleep(1200);
      rmSync(appDest, { recursive: true, force: true });
    }
    // ditto, not cp: it preserves the code signature and extended attributes,
    // and a broken signature means Gatekeeper refuses to open it at all.
    run("ditto", [src, appDest]);
  } finally {
    spawnSync("hdiutil", ["detach", mount, "-quiet"], { stdio: "ignore" });
    rmSync(mount, { recursive: true, force: true });
  }
  return { installed: true, at: appDest };
}

async function installDesktop(det, opt, { version, confirm }) {
  const asset = await resolveAsset(opt, version);
  out(`  ${dim(`${asset.name} · ${asset.tag}`)}`);
  const file = path.join(DOWNLOADS, asset.name);
  await download(asset.url, file);

  if (opt.kind === "dmg") {
    const r = await installDmg(file, { confirm });
    if (!r.installed) return { launched: false, at: r.at, note: "left the existing copy alone" };
    spawn("open", ["-a", r.at], { detached: true, stdio: "ignore" }).unref();
    return { launched: true, at: r.at };
  }

  if (opt.kind === "exe") {
    // The installer owns the rest of the flow (and its own UI), so hand off and
    // get out of the way rather than trying to narrate it.
    spawn("cmd", ["/c", "start", "", file], { detached: true, stdio: "ignore" }).unref();
    return { launched: false, at: file, note: "the Windows installer is opening — follow it" };
  }

  if (opt.kind === "deb") {
    if (!has("sudo")) throw new Error(`no sudo here — install it yourself: dpkg -i ${file}`);
    out(`  ${dim("installing the package (sudo may ask for your password)…")}`);
    if (has("apt-get")) run("sudo", ["apt-get", "install", "-y", file]);
    else run("sudo", ["dpkg", "-i", file]);
    return {
      launched: false,
      at: "/opt/Pounce",
      note: "launch Pounce from your applications menu",
    };
  }

  // tar.gz: Electrobun's own installer, which drops the app in ~/.local/share
  // and writes a desktop entry.
  const tmp = mkdtempSync(path.join(os.tmpdir(), "pounce-app-"));
  try {
    run("tar", ["xzf", file, "-C", tmp]);
    const installer = path.join(tmp, "installer");
    if (!existsSync(installer)) throw new Error("no installer inside the archive");
    chmodSync(installer, 0o755);
    run(installer, [], { cwd: tmp });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return {
    launched: false,
    at: path.join(os.homedir(), ".local", "share"),
    note: "launch Pounce from your applications menu",
  };
}

// --- installing the background bridge ----------------------------------------

async function bridgeAlive(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(900),
    });
    return res.ok && (await res.json()).ok === true;
  } catch {
    return false;
  }
}

/** The running bridge's own token, so a service install doesn't orphan phones
 *  that already paired with this machine. */
async function runningToken(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/ui`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    return (await res.json()).token || null;
  } catch {
    return null;
  }
}

function storedToken() {
  try {
    const t = readFileSync(TOKEN_FILE, "utf8").trim();
    if (t) return t;
  } catch {}
  // Same minting as `pounce` itself: random per machine, never a well-known
  // default — the tunnel node id is discoverable, so the token must not be.
  const t = crypto.randomBytes(12).toString("base64url");
  mkdirSync(POUNCE_DIR, { recursive: true });
  writeFileSync(TOKEN_FILE, `${t}\n`, { mode: 0o600 });
  return t;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * A path to launcher.mjs that will still be there next time this machine boots.
 *
 * Run through `npx`, this package lives in npm's `_npx` cache — a directory npm
 * prunes whenever it feels like it. A login service pointed at that path works
 * beautifully until the day it silently doesn't, so in that case install a copy
 * we own under ~/.pounce/app and point the service at that instead.
 */
function stableLauncher(version) {
  const local = [
    path.join(PKG_ROOT, "dist", "launcher.mjs"),
    path.join(PKG_ROOT, "src", "launcher-entry.mjs"),
  ].find(existsSync);
  const ephemeral = /[\\/](_npx|_cacache)[\\/]/.test(PKG_ROOT);
  if (local && !ephemeral) return { launcher: local, copied: false };

  const npm = IS_WIN ? "npm.cmd" : "npm";
  if (!has(npm)) throw new Error("npm not found on PATH — needed to install a permanent copy");
  out(`  ${dim(`installing a permanent copy in ${APP_DIR}…`)}`);
  mkdirSync(APP_DIR, { recursive: true });
  run(npm, [
    "install",
    "--prefix",
    APP_DIR,
    `use-pounce@${version}`,
    "--no-audit",
    "--no-fund",
    "--loglevel=error",
  ]);
  const copied = path.join(APP_DIR, "node_modules", "use-pounce", "dist", "launcher.mjs");
  if (!existsSync(copied)) throw new Error(`install finished but ${copied} is missing`);
  return { launcher: copied, copied: true };
}

const LAUNCHD_LABEL = "com.pounce.bridge";
const LAUNCHD_PLIST = path.join(os.homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
const SYSTEMD_UNIT = "pounce-bridge.service";
const SYSTEMD_PATH = path.join(os.homedir(), ".config", "systemd", "user", SYSTEMD_UNIT);
const WIN_TASK = "PounceBridge";
const WIN_CMD = path.join(POUNCE_DIR, "run-bridge.cmd");

function serviceLog(det) {
  if (det.platform === "darwin")
    return path.join(os.homedir(), "Library", "Logs", "pounce-bridge.log");
  if (det.platform === "win32")
    return path.join(process.env.LOCALAPPDATA || POUNCE_DIR, "Pounce", "pounce-bridge.log");
  return null; // journald
}

function installLaunchd({ launcher, port, token, log }) {
  mkdirSync(path.dirname(LAUNCHD_PLIST), { recursive: true });
  mkdirSync(path.dirname(log), { recursive: true });
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${launcher}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>BRIDGE_TOKEN</key><string>${token}</string>
    <key>BRIDGE_PORT</key><string>${port}</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>WorkingDirectory</key><string>${os.homedir()}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict>
</plist>
`;
  writeFileSync(LAUNCHD_PLIST, plist);
  spawnSync("launchctl", ["unload", LAUNCHD_PLIST], { stdio: "ignore" });
  run("launchctl", ["load", "-w", LAUNCHD_PLIST], { stdio: "ignore" });
  return `launchd agent ${LAUNCHD_LABEL}`;
}

function installSystemd({ launcher, port, token }) {
  if (!has("systemctl"))
    throw new Error(
      `no systemctl here (non-systemd distro?) — run it yourself: BRIDGE_PORT=${port} BRIDGE_TOKEN=${token} node "${launcher}"`,
    );
  mkdirSync(path.dirname(SYSTEMD_PATH), { recursive: true });
  writeFileSync(
    SYSTEMD_PATH,
    `[Unit]
Description=Pounce bridge (hosts this machine's coding agents for the Pounce app)
After=network-online.target

[Service]
ExecStart=${process.execPath} ${launcher}
WorkingDirectory=${os.homedir()}
Environment=BRIDGE_TOKEN=${token}
Environment=BRIDGE_PORT=${port}
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`,
  );
  run("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
  run("systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT], { stdio: "ignore" });
  return `systemd user service ${SYSTEMD_UNIT}`;
}

function installScheduledTask({ launcher, port, token, log }) {
  mkdirSync(path.dirname(log), { recursive: true });
  mkdirSync(POUNCE_DIR, { recursive: true });
  // A Scheduled Task action can't carry environment variables and won't restart
  // a process that exits, so a wrapper .cmd does both.
  writeFileSync(
    WIN_CMD,
    `@echo off\r
set "BRIDGE_TOKEN=${token}"\r
set "BRIDGE_PORT=${port}"\r
:loop\r
"${process.execPath}" "${launcher}" >> "${log}" 2>&1\r
timeout /t 2 /nobreak >nul\r
goto loop\r
`,
    "ascii",
  );
  const ps = `
$ErrorActionPreference = "Stop"
Unregister-ScheduledTask -TaskName '${WIN_TASK}' -Confirm:$false -ErrorAction SilentlyContinue
$action    = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c "${WIN_CMD}"'
$trigger   = New-ScheduledTaskTrigger -AtLogOn
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries \`
             -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -Hidden
Register-ScheduledTask -TaskName '${WIN_TASK}' -Action $action -Trigger $trigger \`
  -Principal $principal -Settings $settings -Description 'Pounce bridge' | Out-Null
Start-ScheduledTask -TaskName '${WIN_TASK}'
`;
  run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps], {
    stdio: "ignore",
  });
  return `scheduled task ${WIN_TASK}`;
}

/** Is a login service already in place? Shown in the summary so re-running
 *  `configure` reads as a status check rather than a blind reinstall. */
export function serviceInstalled(det) {
  if (det.platform === "darwin") return existsSync(LAUNCHD_PLIST);
  if (det.platform === "linux") return existsSync(SYSTEMD_PATH);
  if (det.platform === "win32")
    return spawnSync("schtasks", ["/Query", "/TN", WIN_TASK], { stdio: "ignore" }).status === 0;
  return false;
}

async function installBridge(det, { port, version, confirm }) {
  // A bridge already on this port would beat the service to the bind. Ours is
  // ours to stop; anything else (the desktop app, an old launchd install) is
  // not, so say so and let the person decide.
  const alive = await bridgeAlive(port);
  const token = (await runningToken(port)) || storedToken();
  if (alive) {
    let meta = null;
    try {
      meta = JSON.parse(readFileSync(metaFile(port), "utf8"));
    } catch {}
    if (meta && pidAlive(meta.pid)) {
      out(`  ${dim("stopping the bridge this CLI started, so the service can take the port…")}`);
      process.kill(meta.pid, "SIGTERM");
      const deadline = Date.now() + 5000;
      while (pidAlive(meta.pid) && Date.now() < deadline) await sleep(150);
      rmSync(metaFile(port), { force: true });
    } else {
      out(
        `  ${yellow("!")} a bridge is already running on port ${port} that this CLI didn't start`,
      );
      out(`    ${dim("(the desktop app, or an earlier install — it hosts your agents already)")}`);
      const ok = await confirm("Install the login service anyway?");
      if (!ok) return null;
    }
  }

  const { launcher, copied } = stableLauncher(version);
  const log = serviceLog(det);
  const what =
    det.platform === "darwin"
      ? installLaunchd({ launcher, port, token, log })
      : det.platform === "linux"
        ? installSystemd({ launcher, port, token })
        : det.platform === "win32"
          ? installScheduledTask({ launcher, port, token, log })
          : (() => {
              throw new Error(`no login service for ${det.platform}`);
            })();

  const deadline = Date.now() + 20_000;
  let up = false;
  while (Date.now() < deadline && !(up = await bridgeAlive(port))) await sleep(400);
  return { what, log, copied, launcher, up, port };
}

/** Take the login service back off. Mirrors every install path above. */
export function removeService(det) {
  const done = [];
  if (existsSync(LAUNCHD_PLIST)) {
    spawnSync("launchctl", ["unload", LAUNCHD_PLIST], { stdio: "ignore" });
    rmSync(LAUNCHD_PLIST, { force: true });
    done.push(`launchd agent ${LAUNCHD_LABEL}`);
  }
  if (existsSync(SYSTEMD_PATH)) {
    if (has("systemctl")) {
      spawnSync("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT], { stdio: "ignore" });
      spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
    }
    rmSync(SYSTEMD_PATH, { force: true });
    done.push(`systemd user service ${SYSTEMD_UNIT}`);
  }
  if (det.platform === "win32" && serviceInstalled(det)) {
    spawnSync("schtasks", ["/End", "/TN", WIN_TASK], { stdio: "ignore" });
    spawnSync("schtasks", ["/Delete", "/TN", WIN_TASK, "/F"], { stdio: "ignore" });
    rmSync(WIN_CMD, { force: true });
    done.push(`scheduled task ${WIN_TASK}`);
  }
  return done;
}

// --- asking ------------------------------------------------------------------

/** Ctrl-D (and Ctrl-C) at a prompt means "I'm out", not a crash — readline
 *  rejects with an AbortError, and a stack trace is a terrible answer to
 *  someone changing their mind. */
const bailed = (e) => e?.code === "ABORT_ERR" || e?.name === "AbortError";

async function ask(question, choices, defaultKey) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    out(`\n${bold(question)}\n`);
    choices.forEach((ch, i) => {
      const mark = ch.key === defaultKey ? green("›") : " ";
      out(
        `  ${mark} ${bold(String(i + 1))}. ${ch.title}${ch.key === defaultKey ? dim("  (recommended)") : ""}`,
      );
      out(`       ${dim(ch.detail)}`);
    });
    for (;;) {
      let a;
      try {
        a = (
          await rl.question(
            `\n  Pick 1-${choices.length} ${dim(`[${choices.findIndex((ch) => ch.key === defaultKey) + 1}]`)}: `,
          )
        ).trim();
      } catch (e) {
        if (bailed(e)) return "none";
        throw e;
      }
      if (!a) return defaultKey;
      const n = Number(a);
      if (Number.isInteger(n) && n >= 1 && n <= choices.length) return choices[n - 1].key;
      const byKey = choices.find((ch) => ch.key === a.toLowerCase());
      if (byKey) return byKey.key;
      out(`  ${red("?")} ${dim(`type a number between 1 and ${choices.length}`)}`);
    }
  } finally {
    rl.close();
  }
}

function confirmer(yes) {
  return async (question) => {
    if (yes) return true;
    if (!process.stdin.isTTY) return false;
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const a = (await rl.question(`  ${question} ${dim("[y/N]")} `)).trim().toLowerCase();
      return a === "y" || a === "yes";
    } catch (e) {
      if (bailed(e)) return false;
      throw e;
    } finally {
      rl.close();
    }
  };
}

// --- the command --------------------------------------------------------------

export async function runConfigure({ port, version, want = null, yes = false, remove = false }) {
  const det = detectPlatform();
  out(`\n${bold("🐾 Pounce")} ${dim(`v${version}`)} — set this machine up\n`);
  out(`  ${dim("this machine")}  ${det.label}${det.remote ? dim(" · over SSH") : ""}`);

  if (remove) {
    const done = removeService(det);
    out(
      done.length
        ? `\n  ${green("✓")} removed ${done.join(", ")}\n`
        : `\n  ${dim("no Pounce login service was installed")}\n`,
    );
    return;
  }

  const desktop = desktopOption(det);
  const installedAt = desktopInstalledAt(det);
  const haveService = serviceInstalled(det);
  if (installedAt) out(`  ${dim("desktop app")}   ${green("installed")} ${dim(installedAt)}`);
  if (haveService) out(`  ${dim("bridge")}        ${green("installed as a login service")}`);

  const choices = [];
  if (desktop.available) {
    choices.push({
      key: "desktop",
      title: installedAt ? "The desktop app — reinstall the latest" : "The desktop app",
      detail:
        det.platform === "darwin"
          ? "the whole Pounce UI on this Mac, bridge built in, pairing QR in the window"
          : "the Pounce app in your tray, bridge built in, pairing QR one click away",
    });
  }
  choices.push({
    key: "bridge",
    title: haveService ? "The background bridge — reinstall it" : "The background bridge",
    detail: "no window: starts at login, restarts on crash, pairs from the terminal",
  });
  choices.push({
    key: "none",
    title: "Nothing for now",
    detail: "`pounce` still starts a bridge for as long as you leave it running",
  });

  if (!desktop.available) out(`  ${dim(`desktop app`)}   ${dim(`unavailable — ${desktop.why}`)}`);

  // Where there's a screen, the app is the better first experience. Over SSH or
  // on a headless box it's the wrong answer even when it would technically run.
  const recommended = desktop.available && !det.remote && !det.headless ? "desktop" : "bridge";

  let choice = want;
  if (!choice) {
    if (!process.stdin.isTTY) {
      out(`\n  ${yellow("!")} not a terminal — pick one explicitly:`);
      out(
        `    ${dim("pounce configure --desktop")}   ${dim("or")}   ${dim("pounce configure --bridge")}`,
      );
      process.exitCode = 2;
      return;
    }
    choice = yes
      ? recommended
      : await ask("How should Pounce run on this machine?", choices, recommended);
  }
  if (choice === "desktop" && !desktop.available)
    throw new Error(`the desktop app can't run here — ${desktop.why}`);

  const confirm = confirmer(yes);

  if (choice === "none") {
    out(`\n  ${dim("nothing installed. Run")} ${bold("pounce")} ${dim("any time to pair.")}\n`);
    return;
  }

  if (choice === "desktop") {
    out(`\n${bold("Installing the desktop app")}`);
    const r = await installDesktop(det, desktop, { version, confirm });
    out(`\n  ${green("✓")} ${r.at}`);
    if (r.note) out(`  ${dim(r.note)}`);
    if (r.launched) out(`  ${dim("it's opening now — the pairing QR is in the window")}`);
    if (haveService)
      out(
        `  ${yellow("!")} the background bridge is also installed and will fight the app for port ${port} — remove it with ${bold("pounce configure --remove")}`,
      );
    out();
    return;
  }

  out(`\n${bold("Installing the background bridge")}`);
  const r = await installBridge(det, { port, version, confirm });
  if (!r) {
    out(`\n  ${dim("left the running bridge alone — nothing installed.")}\n`);
    return;
  }
  out(`\n  ${green("✓")} ${r.what}`);
  out(`  ${dim(`starts at login, restarts on crash, port ${r.port}`)}`);
  if (r.copied) out(`  ${dim(`running from ${r.launcher}`)}`);
  if (r.log) out(`  ${dim(`logs: ${r.log}`)}`);
  else out(`  ${dim(`logs: journalctl --user -u ${SYSTEMD_UNIT} -f`)}`);
  if (det.platform === "linux")
    out(`  ${dim("keep it running while logged out: sudo loginctl enable-linger $USER")}`);
  out(
    r.up
      ? `  ${green("✓")} it's up — run ${bold("pounce")} to show the pairing QR`
      : `  ${yellow("!")} it hasn't answered yet — check the log, then run ${bold("pounce status")}`,
  );
  out(`  ${dim("remove it again: pounce configure --remove")}\n`);
}
