/**
 * Spawn environment for agent CLIs. GUI-launched apps inherit a bare PATH (no
 * Homebrew, no version-manager shims), so `claude`/`opencode`/`codex` — and the
 * `env node` shebangs inside them — can fail to resolve. APPEND the usual
 * install locations: a tool the caller's PATH already resolves must win, or a
 * broken Homebrew toolchain shadows a working version-manager one (seen live:
 * homebrew node linked against a deleted libllhttp dylib killed every spawn).
 */
import os from "node:os";
import path from "node:path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { readConfig, binOverride } from "./config.mjs";

const IS_WIN = process.platform === "win32";

/**
 * The PATH the user actually has in a terminal, read once from their login
 * shell.
 *
 * The hardcoded list below covers the common installers, but not a tool kept
 * somewhere personal — and that's exactly the case a GUI launch breaks, because
 * Finder/Dock give a process `/usr/bin:/bin:/usr/sbin:/sbin` and nothing else.
 * (Found via `cursor-agent`, which lives in ~/.superset/bin here: it resolved
 * when the bridge was started from a terminal and vanished when the app spawned
 * it.) A login shell is the only thing that knows the user's real PATH, so ask
 * it once and cache — it costs a few hundred ms on first use and nothing after.
 */
let loginPathCache;
function loginShellPath() {
  if (loginPathCache !== undefined) return loginPathCache;
  loginPathCache = null;
  if (IS_WIN) return loginPathCache;
  try {
    const shell = process.env.SHELL || "/bin/zsh";
    const r = spawnSync(shell, ["-lc", 'printf %s "$PATH"'], {
      encoding: "utf8",
      timeout: 4000,
      // A login shell that prompts or writes noise must not hang the bridge.
      stdio: ["ignore", "pipe", "ignore"],
    });
    const out = r.stdout?.trim();
    if (out && out.includes(path.delimiter)) loginPathCache = out;
  } catch {
    // Keep null: the hardcoded dirs below still apply.
  }
  return loginPathCache;
}

export function agentEnv() {
  const home = os.homedir();
  const cfg = readConfig();
  const extra = IS_WIN
    ? [
        process.env.ProgramFiles && path.join(process.env.ProgramFiles, "nodejs"),
        process.env.APPDATA && path.join(process.env.APPDATA, "npm"),
        path.join(home, ".bun", "bin"),
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Volta", "bin"),
      ]
    : [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        `${home}/.local/bin`,
        `${home}/.volta/bin`,
        `${home}/.bun/bin`,
        `${home}/.claude/local`,
        `${home}/.nvm/current/bin`,
        `${home}/.fnm/aliases/default/bin`,
      ];
  // A user-pinned binary's directory goes on the FRONT so both the binary itself
  // and any `#!/usr/bin/env node` shebang inside a wrapper resolve to the pinned
  // toolchain. Then the caller's PATH, then their extra dirs, then our defaults.
  const overrideDirs = Object.values(cfg.bins).map((p) => path.dirname(p));
  // Login-shell PATH sits after the caller's own but before our guesses: it's
  // the user's real setup, and more trustworthy than a hardcoded list.
  const PATH = [
    ...overrideDirs,
    process.env.PATH || "",
    loginShellPath() || "",
    ...cfg.extraPath,
    ...extra.filter(Boolean),
  ]
    .filter(Boolean)
    .join(path.delimiter);
  // cfg.env comes before PATH so our computed PATH always wins.
  return { ...process.env, ...cfg.env, PATH };
}

/**
 * How to invoke a named binary: the user's pinned absolute path if set, else the
 * bare name for PATH resolution. Use this instead of spawning the literal name
 * so custom setups (shadowed/oddly-installed CLIs) can be fixed from the app.
 */
export function binPath(name) {
  return binOverride(name) || name;
}

/**
 * The machine's reachable LAN IPv4 address(es), best candidate first. The naive
 * "first non-internal IPv4" breaks on Macs with a VPN, Docker, Tailscale, or
 * Ethernet+Wi-Fi, where it can advertise an address the phone can't reach — the
 * classic "pairing QR doesn't work on the same Wi-Fi". Prefer real private-LAN
 * addresses on physical interfaces (en*), skip virtual/link-local/CGNAT.
 */
export function lanIps() {
  const VIRTUAL = /^(utun|awdl|llw|bridge|vnic|vbox|vmnet|docker|tap|tun|ham|zt|gpd|ppp)/i;
  const isPrivate = (a) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a);
  const rows = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (VIRTUAL.test(name)) continue;
    for (const a of addrs || []) {
      if (a.family !== "IPv4" || a.internal) continue;
      if (/^169\.254\./.test(a.address)) continue; // link-local
      if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address)) continue; // CGNAT (Tailscale)
      rows.push({ address: a.address, priv: isPrivate(a.address), phys: /^en\d/i.test(name) });
    }
  }
  rows.sort((x, y) => Number(y.priv) - Number(x.priv) || Number(y.phys) - Number(x.phys));
  return rows.map((r) => r.address);
}

/** The single best LAN IP to advertise (or null when offline). */
export function primaryLanIp() {
  return lanIps()[0] || null;
}

/** Run a command, collecting stdout (capped) with a 5s kill timeout.
 *  Resolves { code, out }; failures resolve { code: -1, out: "" }. */
function runCollect(cmd, args, { env, maxBytes = Infinity } = {}) {
  return new Promise((resolve) => {
    let p;
    try {
      p = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    } catch {
      return resolve({ code: -1, out: "" });
    }
    let out = "";
    const t = setTimeout(() => {
      try {
        p.kill("SIGKILL");
      } catch {}
    }, 5000);
    p.stdout.on("data", (d) => {
      if (out.length < maxBytes) out += d;
    });
    p.on("close", (code) => {
      clearTimeout(t);
      resolve({ code, out });
    });
    p.on("error", () => {
      clearTimeout(t);
      resolve({ code: -1, out: "" });
    });
  });
}

/** Agent CLIs whose live processes we track for activity judgment. */
const AGENT_BINS = new Set(["claude", "codex", "opencode", "cursor-agent"]);
let liveCwdsCache = { at: 0, promise: null };

/**
 * Working directories of live agent CLI processes, as Map<binName, Set<cwd>>.
 * The session id of an external agent process is unobservable (no lock file,
 * not in argv/env, transcript not held open), but its cwd is — and in the
 * worktree-per-session flow that's nearly a session identifier. Used to judge
 * "running" by process liveness instead of transcript-mtime guessing.
 * The in-flight promise is cached for 5s (failures included) so a burst of
 * per-thread getActivity calls shares ONE ps/lsof scan. Resolves null when
 * the scan isn't possible (Windows, ps failure) so callers can fall back to
 * the mtime heuristic.
 */
export function liveAgentCwds() {
  if (IS_WIN) return Promise.resolve(null);
  if (liveCwdsCache.promise && Date.now() - liveCwdsCache.at < 5_000) {
    return liveCwdsCache.promise;
  }
  liveCwdsCache = { at: Date.now(), promise: scanLiveAgentCwds() };
  return liveCwdsCache.promise;
}

async function scanLiveAgentCwds() {
  try {
    const { out: ps } = await runCollect("ps", ["-axo", "pid=,command="]);
    if (!ps) return null;
    const pids = []; // [pid, binName]
    for (const line of ps.split("\n")) {
      const m = line.match(/^\s*(\d+)\s+(\S+)/);
      if (!m) continue;
      const base = path.basename(m[2]);
      if (AGENT_BINS.has(base)) pids.push([m[1], base]);
    }
    const value = new Map();
    if (pids.length) {
      if (existsSync("/proc")) {
        for (const [pid, name] of pids) {
          try {
            addCwd(value, name, readlinkSync(`/proc/${pid}/cwd`));
          } catch {}
        }
      } else {
        // macOS: one batched lsof for all agent pids. -Fpn = p<pid> / n<path>.
        const { out } = await runCollect("lsof", [
          "-a",
          "-p",
          pids.map(([p]) => p).join(","),
          "-d",
          "cwd",
          "-Fpn",
        ]);
        let cur = null;
        for (const line of out.split("\n")) {
          if (line.startsWith("p")) cur = line.slice(1);
          else if (line.startsWith("n") && cur !== null) {
            const name = pids.find(([p]) => p === cur)?.[1];
            if (name) addCwd(value, name, line.slice(1));
          }
        }
      }
    }
    return value;
  } catch {
    return null;
  }
}

function addCwd(map, name, cwd) {
  if (!map.has(name)) map.set(name, new Set());
  map.get(name).add(cwd);
}

/**
 * Locate a binary on the agent PATH without running it. Returns an absolute
 * path or null. Pure stat work — the cheap half of "is this agent installed?".
 */
export function resolveBin(name) {
  const pinned = binOverride(name);
  if (pinned) return existsSync(pinned) ? pinned : null;
  const exts = IS_WIN ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (agentEnv().PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = path.join(dir, name + ext);
      try {
        if (existsSync(full)) return full;
      } catch {}
    }
  }
  return null;
}

/**
 * Version cache, persisted across restarts at ~/.pounce/bin-versions.json.
 *
 * Keyed on the binary's absolute path plus its mtime and size, so an upgraded
 * CLI misses the cache and gets re-probed while an unchanged one never does.
 */
const VERSION_FILE = path.join(os.homedir(), ".pounce", "bin-versions.json");
let versionCache;

function loadVersionCache() {
  if (versionCache) return versionCache;
  try {
    versionCache = JSON.parse(readFileSync(VERSION_FILE, "utf8"));
  } catch {
    versionCache = {};
  }
  return versionCache;
}

function saveVersionCache() {
  try {
    mkdirSync(path.dirname(VERSION_FILE), { recursive: true });
    const tmp = `${VERSION_FILE}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(versionCache));
    renameSync(tmp, VERSION_FILE); // atomic: a torn file would cost a re-probe
  } catch {}
}

/**
 * The trimmed first line of a CLI's `--version`, or null when it isn't
 * installed or doesn't answer. Backs `isAvailable`, so an agent without its
 * binary simply doesn't appear in the app.
 *
 * Spawning is the last resort, not the first. `isAvailable` runs on every
 * /v1/agents AND inside getThreads, both cached for only 20s — so the old
 * unconditional probe respawned every agent CLI three times a minute forever,
 * and cost 1.4s of a 2.1s cold start (measured, 4 agents). A missing binary now
 * costs one stat, and an unchanged one costs a stat plus a JSON lookup.
 */
export async function binVersion(bin, args = ["--version"]) {
  const resolved = resolveBin(binPath(bin));
  if (!resolved) return null; // not installed — nothing to spawn

  let stamp = null;
  try {
    const st = statSync(resolved);
    stamp = `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
  const key = `${resolved}|${args.join(" ")}`;
  const cache = loadVersionCache();
  const hit = cache[key];
  if (hit && hit.stamp === stamp) return hit.version;

  const { code, out } = await runCollect(resolved, args, { env: agentEnv(), maxBytes: 4096 });
  const version = code === 0 ? out.trim().split("\n")[0] || "" : null;
  cache[key] = { stamp, version };
  saveVersionCache();
  return version;
}
