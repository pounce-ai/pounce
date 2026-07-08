#!/usr/bin/env node
/**
 * Pounce Bridge — runs on the machine hosting the alleycat (kittylitter) daemon.
 *
 * The daemon is Iroh-only (UDP/QUIC, no local HTTP), so a phone can't reach it
 * directly without the native Iroh client. This bridge stands in: it speaks to
 * the daemon via `kittylitter probe` (a real Iroh JSON-RPC client) and re-exposes
 * the data over plain HTTP on the LAN, which the Pounce app can consume today.
 *
 *   node apps/bridge/server.mjs
 *
 * Env:
 *   BRIDGE_PORT   (default 8099)
 *   BRIDGE_TOKEN  (default: derived; printed at startup) — required by clients
 *   KITTYLITTER   (path to the kittylitter binary; auto-detected otherwise)
 *
 * Auth: clients send `Authorization: Bearer <BRIDGE_TOKEN>` or `?token=`.
 */
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import qrcode from "qrcode-terminal";
import QRCode from "qrcode";
import { parseUserMessage, stripNoise } from "@litter/transcript";

const IS_WIN = process.platform === "win32";

const PORT = Number(process.env.BRIDGE_PORT || 8099);
// How often the background watcher polls for state transitions to push.
const WATCH_MS = Number(process.env.PUSH_WATCH_MS || 25_000);
const TOKEN = process.env.BRIDGE_TOKEN || "pounce-bridge-local";
// The Bridge desktop app version, shown in the pairing window's footer. The
// desktop shell passes it to startBridge() from its package.json; env is the
// fallback for standalone `node server.mjs` runs.
let APP_VERSION = process.env.BRIDGE_APP_VERSION || null;
// Kittylitter invocation resolver. A GUI-launched app inherits a minimal PATH
// and the npx cache hash rotates whenever the cache is cleared/re-fetched, so we
// must NOT freeze a path at import. (That was the bug: resolve once → the daemon
// later starts via npx → the bridge keeps spawning a now-absent binary → every
// probe/status ENOENTs → "Starting your agent host…" forever, zero threads.)
// Instead: resolve lazily, allow re-resolution, and fall back to
// `npx -y kittylitter@latest`, which always works when node is present and drives
// the same cache the daemon was installed into.
function findKlBinary() {
  if (process.env.KITTYLITTER) return process.env.KITTYLITTER;
  if (IS_WIN) return null; // Windows resolves the JS entry instead (findKlJsEntry)
  const npxRoot = `${os.homedir()}/.npm/_npx`;
  try {
    for (const hash of readdirSync(npxRoot)) {
      const p = `${npxRoot}/${hash}/node_modules/kittylitter/node_modules/.bin_real/kittylitter`;
      if (existsSync(p)) return p;
    }
  } catch {}
  return null;
}

/** Read a kittylitter package dir's bin entry and resolve it to an absolute JS path. */
function klJsFromPackage(pkgDir) {
  try {
    const pkg = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
    const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.kittylitter;
    if (!bin) return null;
    const entry = path.join(pkgDir, bin);
    return existsSync(entry) ? entry : null;
  } catch { return null; }
}

/**
 * Windows: find kittylitter's JS entrypoint so we can run `node <entry> …`
 * directly. The npm shims (.cmd/.ps1) can't be spawned without a shell — and a
 * shell would let user text passed as probe params escape into cmd.exe — so the
 * only safe invocation is node + the real script. Checks the npm global root
 * first, then the npx cache the daemon bootstrap installs into.
 */
function findKlJsEntry() {
  const candidates = [];
  if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, "npm", "node_modules", "kittylitter"));
  const npxCaches = [
    process.env.npm_config_cache,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "npm-cache"),
  ].filter(Boolean).map((c) => path.join(c, "_npx"));
  for (const root of npxCaches) {
    try {
      for (const hash of readdirSync(root)) candidates.push(path.join(root, hash, "node_modules", "kittylitter"));
    } catch {}
  }
  for (const dir of candidates) {
    const entry = klJsFromPackage(dir);
    if (entry) return entry;
  }
  return null;
}

// GUI apps launched from Finder/Dock get a bare PATH (no Homebrew, no node
// version-manager shims), so `npx`/`node` and the binary's `env node` shebang can
// fail to resolve. Prepend the usual install locations for every kittylitter call.
function augmentedPath() {
  const home = os.homedir();
  const extra = IS_WIN
    ? [
        process.env.ProgramFiles && path.join(process.env.ProgramFiles, "nodejs"),
        process.env.APPDATA && path.join(process.env.APPDATA, "npm"),
        path.join(home, ".bun", "bin"),
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Volta", "bin"),
      ]
    : [
        "/opt/homebrew/bin", "/usr/local/bin", `${home}/.local/bin`,
        `${home}/.volta/bin`, `${home}/.bun/bin`,
        `${home}/.nvm/current/bin`, `${home}/.fnm/aliases/default/bin`,
      ];
  return [...extra.filter(Boolean), process.env.PATH || ""].filter(Boolean).join(path.delimiter);
}
const KL_ENV = { ...process.env, PATH: augmentedPath() };

let _kl = null; // cached { cmd, prefix, viaCmdShell? }
/**
 * How to invoke kittylitter: the cached binary if present, else via npx.
 * Windows: `node <js-entry>` when the package is findable (the npm .cmd shims
 * can't be spawned shell-less), else npx through cmd.exe — but that fallback is
 * restricted to static-argument commands (see klSpawn) because cmd.exe would
 * reinterpret metacharacters in dynamic args like probe's JSON params.
 */
function klInvocation() {
  if (_kl) return _kl;
  const bin = findKlBinary();
  if (bin) _kl = { cmd: bin, prefix: [] };
  else if (!IS_WIN) _kl = { cmd: "npx", prefix: ["-y", "kittylitter@latest"] };
  else {
    const entry = findKlJsEntry();
    _kl = entry
      ? { cmd: "node", prefix: [entry] }
      : { cmd: process.env.ComSpec || "cmd.exe", prefix: ["/d", "/s", "/c", "npx", "-y", "kittylitter@latest"], viaCmdShell: true };
  }
  return _kl;
}

// Only plain option/identifier-looking args may travel through the cmd.exe npx
// fallback — cmd expands %VAR% and treats &|<>^" specially even inside a spawn
// argv, so anything else (JSON params, free text) is refused outright.
const CMD_SAFE_ARG = /^[A-Za-z0-9@._/:=,-]*$/;

/** A stillborn child that only emits an error — for refused cmd.exe spawns. */
function blockedChild(reason) {
  const c = new EventEmitter();
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.kill = () => {};
  queueMicrotask(() => c.emit("error", Object.assign(new Error(reason), { code: "EBLOCKED" })));
  return c;
}
/** Forget the cached invocation so the next call re-scans the npx cache. Call
 *  this once the daemon is (re)installed so a fresh binary path is picked up
 *  instead of the slower npx path. */
export function refreshKittylitter() { _kl = null; return klInvocation(); }

/** Spawn kittylitter with the resolved invocation and an augmented PATH. */
function klSpawn(args, opts = {}) {
  const inv = klInvocation();
  if (inv.viaCmdShell && !args.every((a) => CMD_SAFE_ARG.test(a))) {
    return blockedChild("kittylitter not installed yet — refusing dynamic args via cmd.exe npx fallback");
  }
  return spawn(inv.cmd, [...inv.prefix, ...args], { env: KL_ENV, windowsHide: true, ...opts });
}

/** A human-readable form of the current invocation, e.g. for logs. */
function klDisplay() {
  const inv = klInvocation();
  return [inv.cmd, ...inv.prefix].join(" ");
}

/** The binary path for the daemon bootstrap (ensureDaemon), or the bare package
 *  name so its own npx logic takes over. Never returns "npx" — that path is the
 *  bridge's concern, not the bootstrap's. Re-resolves on each call. */
export function kittylitterPath() {
  return findKlBinary() || "kittylitter";
}

const CACHE_MS = 20_000;
const cache = new Map(); // key -> { at, value }

/** Extract every balanced-brace JSON object from probe's verbose stdout. */
function extractJsonObjects(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          try { out.push(JSON.parse(text.slice(i, j + 1))); } catch {}
          i = j;
          break;
        }
      }
    }
  }
  return out;
}

function probe(args, { timeout = 30000 } = {}, _retried = false) {
  return new Promise((resolve) => {
    const p = klSpawn(["probe", ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    const t = setTimeout(() => p.kill("SIGKILL"), timeout);
    p.on("close", () => {
      clearTimeout(t);
      resolve(extractJsonObjects(out));
    });
    p.on("error", (e) => {
      clearTimeout(t);
      // Binary path went stale (npx cache rotated / not yet installed) —
      // re-resolve once and retry, which falls back to npx if needed.
      if (!_retried && e?.code === "ENOENT") resolve(probe(args, { timeout }, !!refreshKittylitter()));
      else resolve([]);
    });
  });
}

async function cached(key, ttl, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function getAgents(fresh = false) {
  if (fresh) cache.delete("agents");
  return cached("agents", CACHE_MS, async () => {
    const frames = await probe(["--linger-secs", "1", "--timeout-secs", "20"]);
    const f = frames.find((x) => Array.isArray(x.agents));
    return (f?.agents || []).map((a) => ({
      id: a.name,
      displayName: a.display_name,
      available: !!a.available,
      wire: a.wire,
      description: a.presentation?.description ?? "",
      // Per-agent capabilities (AgentInfo.capabilities) so the mobile composer
      // can show only the inputs an agent actually supports.
      capabilities: a.capabilities ?? null,
    }));
  });
}

/** Run `git -C cwd <args>` and resolve stdout lines (empty on any error). */
function gitList(cwd, args) {
  return new Promise((resolve) => {
    const p = spawn("git", ["-C", cwd, ...args], { stdio: ["ignore", "pipe", "ignore"] });
    let buf = "";
    p.stdout.on("data", (d) => (buf += d));
    p.on("close", () => resolve(buf ? buf.split("\n").filter(Boolean) : []));
    p.on("error", () => resolve([]));
  });
}

/** Run a command, capturing exit code + stdout + stderr. Optional kill timeout. */
function exec(cmd, args, cwd, timeoutMs = 0, env = undefined) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "", killed = false;
    const timer = timeoutMs ? setTimeout(() => { killed = true; p.kill("SIGKILL"); }, timeoutMs) : null;
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, out, err: err + (killed ? "\n[command timed out]" : "") });
    });
    p.on("error", (e) => { if (timer) clearTimeout(timer); resolve({ code: -1, out: "", err: String(e?.message || e) }); });
  });
}
const git = (cwd, args) => exec("git", ["-C", cwd, ...args]);

// --- Daemon (kittylitter serve) lifecycle -----------------------------------
// The bridge proxies the daemon but doesn't own its session index: a daemon that
// has been up for a while stops surfacing sessions created since it indexed, so
// recent threads silently vanish from the app. Expose its start time and a
// restart (deterministic kill + respawn of the same binary the daemon runs — not
// reliant on any auto-start) so a fresh daemon re-indexes everything.
let activeTurns = 0; // turns this bridge is currently streaming — a restart guard
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function daemonPids() {
  const { out } = await exec("pgrep", ["-f", "kittylitter serve"]);
  return out.trim().split(/\s+/).filter(Boolean).map(Number).filter((n) => n && n !== process.pid);
}

async function daemonInfo() {
  const pids = await daemonPids();
  if (!pids.length) return { running: false, pid: null, startedAt: null, uptimeSecs: null, activeTurns };
  const pid = pids[0];
  const { out } = await exec("ps", ["-p", String(pid), "-o", "lstart="]);
  const startedAt = out.trim() ? new Date(out.trim()).toISOString() : null;
  const uptimeSecs = startedAt ? Math.max(0, Math.round((Date.now() - Date.parse(startedAt)) / 1000)) : null;
  return { running: true, pid, startedAt, uptimeSecs, activeTurns };
}

async function restartDaemon() {
  const pids = await daemonPids();
  for (const p of pids) { try { process.kill(p, "SIGTERM"); } catch {} }
  await sleep(800);
  for (const p of pids) { try { process.kill(p, 0); process.kill(p, "SIGKILL"); } catch {} } // straggler
  // Respawn the same binary detached so it re-indexes from a clean slate.
  try {
    spawn(kittylitterPath(), ["serve"], { cwd: "/", detached: true, stdio: "ignore" }).unref();
  } catch {}
  await sleep(1500);
  cache.clear(); // daemon re-indexed — drop every cached list/probe result
  return daemonInfo();
}

// Auto-restart: when a recently-written session on disk isn't in the daemon's
// thread list, the daemon has fallen behind — restart it (only while idle, rate-
// limited) so newly-created threads appear without the user lifting a finger.
const DAEMON_AUTO_RESTART = process.env.DAEMON_AUTO_RESTART !== "0"; // opt out with =0
const STALE_LOOKBACK_MS = 30 * 60_000;       // only act on sessions touched this recently
const AUTORESTART_COOLDOWN_MS = 30 * 60_000; // and no more than once per window
const AUTORESTART_EVERY_MS = 5 * 60_000;     // how often we check
let lastAutoRestart = 0;
let lastAutoRestartFor = null; // don't loop on a session a restart can't index

/** The id of the most-recently-written Claude session on disk, if touched within
 *  the lookback window — the thing the daemon is most likely to be missing. */
function newestRecentSessionId() {
  const root = path.join(os.homedir(), ".claude", "projects");
  let dirs;
  try { dirs = readdirSync(root); } catch { return null; }
  let bestDir = null, bestDirMs = 0; // cheapest path: newest project dir, then its newest file
  for (const d of dirs) {
    let st; try { st = statSync(path.join(root, d)); } catch { continue; }
    if (st.isDirectory() && st.mtimeMs > bestDirMs) { bestDirMs = st.mtimeMs; bestDir = d; }
  }
  if (!bestDir || Date.now() - bestDirMs > STALE_LOOKBACK_MS) return null;
  let id = null, ms = 0;
  let files; try { files = readdirSync(path.join(root, bestDir)); } catch { return null; }
  for (const f of files) {
    if (!f.endsWith(".jsonl")) continue;
    let st; try { st = statSync(path.join(root, bestDir, f)); } catch { continue; }
    if (st.mtimeMs > ms) { ms = st.mtimeMs; id = f.slice(0, -6); }
  }
  return id && Date.now() - ms <= STALE_LOOKBACK_MS ? id : null;
}

async function maybeAutoRestartDaemon() {
  if (!DAEMON_AUTO_RESTART) return;
  if (activeTurns > 0) return;                                  // a turn is streaming through us
  if (Date.now() - lastAutoRestart < AUTORESTART_COOLDOWN_MS) return;
  const newId = newestRecentSessionId();
  if (!newId) return;                                          // nothing fresh to catch up on
  let threads;
  try { threads = await getThreads(); } catch { return; }
  if (threads.some((t) => t.id === newId)) { lastAutoRestartFor = null; return; } // already fresh
  if (newId === lastAutoRestartFor) return;                    // a restart didn't index it — don't loop
  if (threads.some((t) => t.activity === "running" || t.activity === "streaming")) return; // busy elsewhere
  lastAutoRestart = Date.now();
  lastAutoRestartFor = newId;
  console.log(`[daemon] stale: session ${newId} on disk but not indexed — auto-restarting (idle)`);
  try { await restartDaemon(); } catch (e) { console.log(`[daemon] auto-restart failed: ${e?.message || e}`); }
}

/** Uncommitted changes in `cwd`: branch, per-file status + counts, full diff. */
async function gitChanges(cwd) {
  const [numstat, status, diff, branch] = await Promise.all([
    git(cwd, ["diff", "HEAD", "--numstat"]),
    git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]),
    git(cwd, ["-c", "core.quotepath=false", "diff", "HEAD"]),
    git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
  ]);
  const counts = {};
  for (const line of numstat.out.split("\n").filter(Boolean)) {
    const [a, d, ...rest] = line.split("\t");
    counts[rest.join("\t")] = {
      additions: a === "-" ? 0 : Number(a) || 0,
      deletions: d === "-" ? 0 : Number(d) || 0,
    };
  }
  const files = [];
  for (const line of status.out.split("\n").filter(Boolean)) {
    const code = line.slice(0, 2);
    const p = line.slice(3).replace(/^"|"$/g, "");
    let st = "modified";
    if (code.includes("?")) st = "untracked";
    else if (code.includes("A")) st = "added";
    else if (code.includes("D")) st = "deleted";
    else if (code.includes("R")) st = "renamed";
    files.push({ path: p, status: st, ...(counts[p] || { additions: 0, deletions: 0 }) });
  }
  let diffText = diff.out;
  const MAX = 200_000;
  if (diffText.length > MAX) diffText = diffText.slice(0, MAX) + "\n… (diff truncated)";
  return { branch: branch.out.trim(), files, diff: diffText };
}

/**
 * Files + folders under `cwd` for @-mention autocomplete. Uses git (tracked +
 * untracked-but-not-ignored) so it respects .gitignore; falls back to a
 * top-level readdir for non-git dirs. Cached per cwd (filtered in-process).
 */
async function repoEntries(cwd) {
  return cached(`files:${cwd}`, 10_000, async () => {
    const [tracked, others] = await Promise.all([
      gitList(cwd, ["ls-files"]),
      gitList(cwd, ["ls-files", "--others", "--exclude-standard"]),
    ]);
    let files = [...new Set([...tracked, ...others])];
    if (!files.length) {
      try {
        for (const d of readdirSync(cwd, { withFileTypes: true })) {
          if (d.name.startsWith(".")) continue;
          files.push(d.isDirectory() ? `${d.name}/` : d.name);
        }
      } catch {}
    }
    // Derive parent directories from file paths.
    const dirs = new Set();
    for (const f of files) {
      const parts = f.replace(/\/$/, "").split("/");
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
      if (f.endsWith("/")) dirs.add(f.replace(/\/$/, ""));
    }
    return [
      ...[...dirs].map((p) => ({ path: p, type: "dir" })),
      ...files.filter((f) => !f.endsWith("/")).map((p) => ({ path: p, type: "file" })),
    ];
  });
}

/** Rank entries against a lowercase query; basename-prefix wins, then path. */
function rankEntries(all, q) {
  if (!q) return all.filter((e) => !e.path.includes("/")).slice(0, 25);
  const scored = [];
  for (const e of all) {
    const p = e.path.toLowerCase();
    const base = p.split("/").pop();
    let score = -1;
    if (base.startsWith(q)) score = 0;
    else if (base.includes(q)) score = 1;
    else if (p.includes(q)) score = 2;
    if (score >= 0) scored.push([score, e.path.length, e]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return scored.slice(0, 25).map((s) => s[2]);
}

/**
 * Immediate subdirectories of `dir`, for the new-thread folder browser. Hides
 * dotfolders and node_modules (browsing noise), resolves symlinked dirs, and
 * flags git repos so the app can badge them. Sorted case-insensitively.
 */
function listDirs(dir) {
  const out = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (d.name.startsWith(".") || d.name === "node_modules") continue;
    let isDir = d.isDirectory();
    const full = path.join(dir, d.name);
    if (!isDir && d.isSymbolicLink()) {
      try { isDir = statSync(full).isDirectory(); } catch { continue; }
    }
    if (!isDir) continue;
    out.push({ name: d.name, path: full, isRepo: existsSync(path.join(full, ".git")) });
  }
  out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return out;
}

/**
 * Resolve a working directory into repo grouping + worktree info.
 * - Worktrees (`…/worktrees/<workspace>/<name>`) group under ONE repo (the
 *   workspace), with the worktree name as the session label.
 * - `isLive` = the directory still exists (you can resume/steer it); otherwise
 *   it's an archived session (worktree was merged + cleaned up).
 */
function repoInfo(cwd) {
  // Normalize Windows separators so the worktree/basename parsing below only
  // ever sees forward slashes; drive roots (C:\) count as root too.
  const norm = (cwd || "").replace(/\\/g, "/");
  const isRoot = norm === "/" || /^[A-Za-z]:\/?$/.test(norm);
  if (!norm || isRoot || cwd === os.homedir()) {
    return { repo: "Scratch", isWorktree: false, isLive: false, worktree: null };
  }
  const live = existsSync(cwd);
  const m = norm.match(/\/worktrees\/([^/]+)\/(.+)$/);
  if (m) {
    const ws = m[1];
    return { repo: `ws:${ws.slice(0, 8)}`, isWorktree: true, isLive: live, worktree: m[2] };
  }
  const base = norm.replace(/\/+$/, "").split("/").pop() || norm;
  return { repo: base, isWorktree: false, isLive: live, worktree: null };
}

// Worktree sessions live under `…/worktrees/<workspace>/<name>`, so repoInfo can
// only see the opaque workspace id (`ws:<id>`) — the daemon never reports which
// real repo the worktree was cut from. But every git worktree's .git points back
// to its origin, so we resolve the true repo name here (bridge runs on the same
// machine) and fold worktree sessions into that project's folder instead of a
// generic, collision-prone "Workspace". All worktrees under one workspace share
// an origin, so resolve once per workspace id and cache the hit permanently.
const wsRepoCache = new Map(); // workspace id -> real repo name

/** Origin repo name for a worktree cwd, via its git common dir (…/<repo>/.git). */
async function realRepoForWorktree(cwd) {
  const { out } = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const commonDir = out.trim().split(/\r?\n/)[0]?.replace(/\\/g, "/");
  if (!commonDir) return null;
  const repoDir = commonDir.replace(/\/\.git\/?$/, "").replace(/\/+$/, "");
  const name = repoDir.split("/").pop();
  return name && name !== ".git" ? name : null;
}

/** Rewrite worktree threads' `repo` from `ws:<id>` to their real origin repo,
 *  so they group with that project. Best-effort: unresolved workspaces keep the
 *  `ws:` label. Mutates threads in place. */
async function resolveWorktreeRepos(threads) {
  const byWs = new Map();
  for (const t of threads) {
    if (!t.isWorktree || !t.cwd) continue;
    const m = t.cwd.replace(/\\/g, "/").match(/\/worktrees\/([^/]+)\//);
    if (!m) continue;
    const group = byWs.get(m[1]) || byWs.set(m[1], []).get(m[1]);
    group.push(t);
  }
  await Promise.all(
    [...byWs.entries()].map(async ([ws, group]) => {
      let name = wsRepoCache.get(ws);
      if (!name) {
        // Only a live worktree dir can run git; skip archived (merged/cleaned) ones.
        for (const t of group) {
          if (!t.isLive) continue;
          name = await realRepoForWorktree(t.cwd).catch(() => null);
          if (name) break;
        }
        if (name) wsRepoCache.set(ws, name); // leave unset on failure so we retry next sync
      }
      if (name) for (const t of group) t.repo = name;
    }),
  );
}

/**
 * The daemon's thread `preview` is the raw first user message, which for slash
 * commands carries the agent's wrapper markup (<local-command-caveat>,
 * <command-message>, <command-name>…). Normalize it here — at ingest, like the
 * message bodies — so every client gets a clean title/preview and none has to
 * re-strip it. Returns clean prose, a "/command args" chip for command-only
 * turns, or null when nothing readable survives.
 */
function cleanPreview(raw, agent) {
  if (!raw) return null;
  const p = parseUserMessage(raw, agent);
  const text =
    p.text ||
    (p.command ? `${p.command.name}${p.command.args ? ` ${p.command.args}` : ""}` : "") ||
    p.output?.text ||
    "";
  return text.trim() || null;
}

/**
 * Walk a paginated daemon list method — frames carry `result.data` +
 * `result.nextCursor`. Maps each raw item (return null to skip) and dedupes by
 * the mapped `id`, so a mishandled cursor can't loop. thread/list and model/list
 * share this convention; this is the single place that implements it.
 */
async function probePaginated(agent, method, mapItem, { max = 60 } = {}) {
  const out = [];
  const seen = new Set();
  let cursor;
  for (let i = 0; i < max; i++) {
    const frames = await probe(
      ["--agent", agent, "--method", method,
       "--params", JSON.stringify(cursor ? { cursor } : {}),
       "--linger-secs", "1", "--timeout-secs", "25"],
      { timeout: 30000 },
    ).catch(() => []);
    const f = frames.find((x) => x?.result && Array.isArray(x.result.data));
    let added = 0;
    for (const raw of f?.result?.data || []) {
      const item = mapItem(raw);
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
      added++;
    }
    cursor = f?.result?.nextCursor;
    if (!cursor || added === 0) break; // no more pages, or the cursor stopped advancing
  }
  return out;
}

async function listThreads(agent) {
  // ~25/page — following the cursor is essential or a machine's older/recent
  // sessions silently vanish from the app. Guard ~1500 threads (60 pages).
  return probePaginated(agent, "thread/list", (t) => {
    if (!t.id) return null;
    const info = repoInfo(t.cwd || "");
    return {
      id: t.id,
      agent,
      cwd: t.cwd || null,
      name: t.name || null,
      preview: cleanPreview(t.preview, agent),
      createdAt: typeof t.createdAt === "number"
        ? new Date(t.createdAt > 1e12 ? t.createdAt : t.createdAt * 1000).toISOString()
        : null,
      gitBranch: t.gitInfo?.branch || null,
      modelProvider: t.modelProvider || null,
      repo: info.repo,
      worktree: info.worktree,
      isWorktree: info.isWorktree,
      isLive: info.isLive,
    };
  });
}

async function getThreads(fresh = false) {
  if (fresh) cache.delete("threads");
  return cached("threads", CACHE_MS, async () => {
    const agents = await getAgents(fresh);
    // List threads for every available JSONL agent (codex, claude, opencode,
    // hermes, …). `shell` has no threads. This replaces a hardcoded allowlist
    // that omitted codex (and amp/pi/grok/…).
    const avail = agents.filter((a) => a.available && a.wire === "jsonl" && a.id !== "shell");
    const lists = await Promise.all(avail.map((a) => listThreads(a.id).catch(() => [])));
    const threads = lists.flat().sort((x, y) => (y.createdAt || "").localeCompare(x.createdAt || ""));

    // Fold worktree sessions into their real origin repo before clients see the
    // list (cheap: one git call per unresolved workspace, then cached).
    await resolveWorktreeRepos(threads);

    // Provisional activity so the list returns fast — real activity is filled in
    // asynchronously below.
    for (const t of threads) {
      t.activity = t.isLive ? "idle" : "completed";
      t.lastActivityAt = t.createdAt;
    }

    // Enrich live threads with real activity from their turn history in the
    // background. Each probe is a fresh Iroh round-trip, so awaiting all of them
    // here previously made the first sync take ~40s. Instead we mutate these same
    // objects in place; since the cache holds these references, the next poll
    // (the app refreshes on an interval) serves the enriched data.
    void enrichThreadActivity(threads);
    return threads;
  });
}

let enrichInFlight = false;
function enrichThreadActivity(threads) {
  if (enrichInFlight) return;
  enrichInFlight = true;
  const liveThreads = threads.filter((t) => t.isLive).slice(0, 30);
  return mapLimit(liveThreads, 4, async (t) => {
    try {
      const a = await threadActivity(t.agent, t.id);
      if (a.activity) t.activity = a.activity;
      if (a.lastActivityAt) t.lastActivityAt = a.lastActivityAt;
    } catch {}
  }).finally(() => { enrichInFlight = false; });
}

function status() {
  return cached("status", CACHE_MS, () => runStatus(false));
}
function runStatus(_retried) {
  return new Promise((resolve) => {
    const p = klSpawn(["status"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", () => {
      const get = (k) => (out.match(new RegExp(`${k}:\\s*(.+)`)) || [])[1]?.trim() || null;
      resolve({
        pid: get("pid"),
        version: get("version"),
        nodeId: get("node id"),
        relay: get("relay"),
        uptimeSecs: Number(get("uptime \\(s\\)")) || null,
        device: os.hostname().replace(/\.local$/, ""),
      });
    });
    p.on("error", (e) => {
      // Stale/absent binary — re-resolve once (falls back to npx) and retry.
      if (!_retried && e?.code === "ENOENT") { refreshKittylitter(); resolve(runStatus(true)); }
      else resolve(null);
    });
  });
}

function textOf(it) {
  const c = it.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((x) => (typeof x === "string" ? x : x?.text || "")).join("");
  return it.text || "";
}

/**
 * Map one daemon item -> timeline event(s). Used for both history (turns) and
 * live streaming (item/started|updated|completed notifications). `streaming`
 * marks an in-flight agentMessage so the app renders it with a caret in place.
 */
function itemToEvents(it, conversationId, seq, ts, streaming = false, agent) {
  const id = it.id || `${conversationId}:${seq}`;
  const base = { id, conversationId, seq, ts };
  switch (it.type) {
    case "userMessage":
      // Strip zero-value plumbing (system reminders, Codex's injected AGENTS.md,
      // caveats) server-side so every client gets clean text. Presentation tags
      // (slash-commands, captured output) are preserved for the app to render.
      return [{ ...base, type: "user_message", text: stripNoise(textOf(it), agent) }];
    case "reasoning": {
      const t = textOf(it);
      return t.trim() ? [{ ...base, type: "thinking_finished", text: t, durationMs: 0 }] : [];
    }
    case "agentMessage":
      return [{ ...base, type: "assistant_message", text: it.text || textOf(it), streaming }];
    case "commandExecution": {
      const out = [{ ...base, type: "tool_call", call: { id, name: "shell", input: { command: it.command }, status: it.status === "completed" ? "success" : "running", startedAt: ts } }];
      if (it.aggregatedOutput)
        out.push({ ...base, id: id + ":o", seq: seq + 0.5, type: "tool_result", result: { toolCallId: id, content: { kind: "text", text: it.aggregatedOutput }, isError: it.status === "failed", durationMs: null } });
      return out;
    }
    case "fileChange": {
      const patch = (it.changes || []).map((c) => c.diff).join("\n");
      return [{ ...base, type: "tool_result", result: { toolCallId: id, content: { kind: "diff", path: it.changes?.[0]?.path || "", patch }, isError: false, durationMs: null } }];
    }
    case "dynamicToolCall":
    case "mcpToolCall":
      return [{ ...base, type: "tool_call", call: { id, name: it.tool || "tool", input: it.arguments, status: it.success === false ? "error" : "success", startedAt: ts } }];
    case "webSearch":
      return [{ ...base, type: "tool_call", call: { id, name: "web_search", input: { query: it.query }, status: "success", startedAt: ts } }];
    default:
      return [];
  }
}

/** Map daemon turns/items -> the app's timeline event shape (history). */
function normalizeTurns(turns, conversationId, agent) {
  const events = [];
  let seq = 0;
  // The daemon may hand back turns newest-first (thread/list is sorted DESC);
  // render order is turn order, so sort ascending by creation time or a
  // once-reversed thread shows its latest turn above the older history.
  const ordered = (turns || [])
    .map((t, i) => [t, i])
    .sort(([a, ai], [b, bi]) => tturn(a) - tturn(b) || ai - bi)
    .map(([t]) => t);
  for (const turn of ordered) {
    const ts = new Date(turn.completedAt || turn.createdAt || Date.now()).toISOString();
    for (const it of turn.items || []) events.push(...itemToEvents(it, conversationId, ++seq, ts, false, agent));
  }
  return events;
}

/** A turn's chronological key (createdAt preferred; completedAt as fallback). */
function tturn(t) {
  return new Date(t?.createdAt || t?.completedAt || 0).getTime();
}

/**
 * Run a turn on the host (the agent actually executes), wait for completion,
 * then re-read the thread so the new user message + agent reply are returned.
 * Re-reading is more robust than parsing the streaming notifications.
 */
async function runTurn(agent, threadId, text) {
  await probe(
    ["--agent", agent,
     "--before-method", "thread/resume", "--before-params", JSON.stringify({ threadId }),
     "--method", "turn/start", "--params", JSON.stringify({ threadId, input: [{ type: "text", text }] }),
     "--until-method", "turn/completed", "--linger-secs", "180", "--timeout-secs", "240"],
    { timeout: 260000 },
  );
  cache.delete("threads");
  // The turn added a user message + agent reply — force a fresh read so the
  // cached history isn't stale.
  return getMessages(agent, threadId, true);
}

/** Stateful extractor: feed it stdout chunks, get back newly-complete objects. */
function makeObjectStream() {
  let buf = "";
  return (chunk) => {
    buf += chunk;
    const out = [];
    let i = 0;
    while (i < buf.length) {
      if (buf[i] !== "{") { i++; continue; }
      let depth = 0, inStr = false, esc = false, end = -1;
      for (let j = i; j < buf.length; j++) {
        const c = buf[j];
        if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; }
        else if (c === '"') inStr = true;
        else if (c === "{") depth++;
        else if (c === "}") { depth--; if (depth === 0) { end = j; break; } }
      }
      if (end === -1) break; // incomplete object; wait for more data
      try { out.push(JSON.parse(buf.slice(i, end + 1))); } catch {}
      i = end + 1;
    }
    buf = buf.slice(i);
    return out;
  };
}

/**
 * Run a turn and stream its item notifications as they arrive. `onEvent` gets a
 * normalized timeline event per item update; `onDone` fires once at completion.
 * Returns a stop() to abort.
 */
/**
 * Halt an in-flight turn for `threadId`. Fire-and-forget over a fresh probe;
 * the daemon routes the interrupt to the active turn. NOTE: method name is
 * best-effort (`turn/interrupt`) — adjust if the daemon names it differently.
 */
function interruptTurn(agent, threadId) {
  return new Promise((resolve) => {
    const p = klSpawn(
      ["probe", "--agent", agent, "--method", "turn/interrupt",
       "--params", JSON.stringify({ threadId }), "--timeout-secs", "10", "--linger-secs", "1"],
      { stdio: ["ignore", "ignore", "ignore"] },
    );
    p.on("close", (code) => resolve(code === 0));
    p.on("error", () => resolve(false));
  });
}

function streamTurn(agent, threadId, text, cwd, onEvent, onDone, opts = {}) {
  // Fresh thread (new conversation) when no resumable threadId: start in `cwd`.
  // Otherwise resume the existing daemon thread.
  const fresh = !threadId || !/^[0-9a-f]{8}-/i.test(threadId);

  // Build the content-block input array. Text first, then any images.
  // NOTE: the image block shape ({type:"image", data, mediaType}) mirrors the
  // text block and the HTTP RunImage type; validate against the live daemon if
  // images don't land — the daemon accepts png/jpeg/gif/webp/bmp base64.
  const input = [{ type: "text", text }];
  for (const img of opts.images || []) {
    if (img?.data) input.push({ type: "image", data: img.data, mediaType: img.mediaType || "image/png" });
  }

  // Extra turn params (TurnStartParams subset). Unknown fields are ignored
  // host-side, so it's safe to include only what the caller set.
  const extra = {};
  if (opts.permissionMode) extra.permissionMode = opts.permissionMode;
  if (opts.reasoningEffort) extra.reasoningEffort = opts.reasoningEffort;
  if (opts.model) extra.model = opts.model;

  const args = fresh
    ? ["probe", "--agent", agent,
       "--start-thread-params", JSON.stringify({ cwd: cwd || os.homedir() }),
       "--method", "turn/start", "--params", JSON.stringify({ input, ...extra })]
    : ["probe", "--agent", agent,
       "--before-method", "thread/resume", "--before-params", JSON.stringify({ threadId }),
       "--method", "turn/start", "--params", JSON.stringify({ threadId, input, ...extra })];
  const p = klSpawn([...args, "--until-method", "turn/completed", "--linger-secs", "240", "--timeout-secs", "300"],
    { stdio: ["ignore", "pipe", "pipe"] });

  const feed = makeObjectStream();
  let seq = 0;
  let finished = false;
  let realThreadId = threadId;
  const acc = new Map(); // itemId -> accumulated streamed text
  const finish = () => { if (finished) return; finished = true; onDone(realThreadId); };
  const now = () => new Date().toISOString();

  const handle = (o) => {
    const m = o.method;
    if (!m || o.id) return; // responses, not notifications
    const p = o.params || {};

    if (m === "thread/started") { realThreadId = p.thread?.id || p.threadId || realThreadId; return; }

    // The daemon warns when the model was rerouted / is deprecated / has config
    // notes (e.g. switching models re-sends full context). Surface it inline.
    if (m === "model/rerouted") {
      const text = p.warning || p.configWarning || p.deprecationNotice;
      if (text) {
        const s = ++seq;
        onEvent({ id: `sysmodel:${s}`, conversationId: threadId, seq: s, ts: now(), type: "system_event", message: String(text), level: "warning" });
      }
      return;
    }

    // Streaming deltas: item/<kind>/delta -> {delta, itemId}. Route reasoning
    // deltas to a thinking trace (shown like Codex/Grok) and message deltas to a
    // streaming assistant bubble, so the two don't get conflated.
    const dm = m.match(/^item\/(.+)\/delta$/);
    if (dm) {
      const itemId = p.itemId;
      if (!itemId || typeof p.delta !== "string") return;
      const text = (acc.get(itemId) || "") + p.delta;
      acc.set(itemId, text);
      const s = ++seq;
      if (/reason|think/i.test(dm[1])) {
        onEvent({ id: itemId, conversationId: threadId, seq: s, ts: now(), type: "thinking_finished", text, durationMs: 0 });
      } else {
        onEvent({ id: itemId, conversationId: threadId, seq: s, ts: now(), type: "assistant_message", text, streaming: true });
      }
      return;
    }
    if (m === "item/started" || m === "item/completed") {
      const item = p.item || p;
      const streaming = m !== "item/completed";
      for (const ev of itemToEvents(item, threadId, ++seq, now(), streaming, agent)) onEvent(ev);
      if (m === "item/completed") acc.delete(item.id);
      return;
    }
    if (m === "turn/completed") finish();
  };

  const onData = (d) => { for (const o of feed(d.toString())) handle(o); };
  p.stdout.on("data", onData);
  p.stderr.on("data", onData);
  const t = setTimeout(() => p.kill("SIGKILL"), 300000);
  p.on("close", () => { clearTimeout(t); finish(); });
  p.on("error", () => finish());
  return () => p.kill("SIGKILL");
}

async function fetchTurns(agent, threadId) {
  const frames = await probe(
    ["--agent", agent, "--before-method", "thread/resume", "--before-params", JSON.stringify({ threadId }),
     "--method", "thread/turns/list", "--params", JSON.stringify({ threadId }),
     // turns/list is plain request/response — linger only waits *after* the
     // response, so any value here is a flat delay added to every history load.
     "--linger-secs", "0", "--timeout-secs", "30"],
    { timeout: 40000 },
  );
  const f = frames.find((x) => x?.result && Array.isArray(x.result.data) && x.id === 2);
  return f?.result?.data || [];
}

/** Cache key for a thread's normalized history. */
const msgKey = (agent, threadId) => `msg:${agent}:${threadId}`;

// Opening a thread was ~4s because every /v1/messages spawned a fresh
// `kittylitter probe`, and each probe pays a full cold Iroh dial (relay
// handshake + QUIC setup) — ~4s wall-clock even at ~0 CPU. A second request on
// an already-warm connection costs ~0.3s, so the fix is to never make the user
// wait on a cold dial: cache history like every sibling endpoint (getThreads /
// getAgents / status) already do, and pre-warm it in the background so the tap
// hits a hot cache instead of a cold probe.
// History is immutable except when a turn completes — and we invalidate the key
// explicitly then (runTurn / streamTurn). So it can hold longer than the 20s
// list cache; a longer TTL means the background warm loop re-probes far less
// often. Pull-to-refresh still forces a fresh read via `fresh=1`.
const MSG_CACHE_MS = 60_000;

async function getMessages(agent, threadId, fresh = false) {
  const key = msgKey(agent, threadId);
  if (fresh) cache.delete(key);
  return cached(key, MSG_CACHE_MS, async () =>
    normalizeTurns(await fetchTurns(agent, threadId), threadId, agent));
}

// --- Per-thread token usage + cost -----------------------------------------
// The daemon exposes no usage, but Claude Code records `message.usage` +
// `message.model` on each assistant line of its own transcript
// (~/.claude/projects/<escaped-cwd>/<sessionId>.jsonl). We read that directly.
// Prices are USD per 1M tokens; cache-read ≈ 0.1× input, cache-write(5m) ≈ 1.25× input.
const MODEL_PRICES = {
  "claude-opus-4-8": { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-7": { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-6": { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-5": { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-1": { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-fable-5": { in: 10, out: 50, cacheRead: 1.0, cacheWrite: 12.5 },
  "claude-mythos-5": { in: 10, out: 50, cacheRead: 1.0, cacheWrite: 12.5 },
  "claude-sonnet-5": { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-sonnet-4-6": { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-sonnet-4-5": { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-haiku-4-5": { in: 1, out: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

/** Price row for a model id, tolerating date-suffixed ids (…-20251001). */
function priceFor(model) {
  if (!model) return null;
  return MODEL_PRICES[model] || MODEL_PRICES[Object.keys(MODEL_PRICES).find((k) => model.startsWith(k))] || null;
}

/** USD for one assistant message's usage, weighting cache tokens per the model. */
function msgCost(model, u) {
  const p = priceFor(model);
  if (!p) return null;
  return (
    ((u.input_tokens || 0) * p.in +
      (u.output_tokens || 0) * p.out +
      (u.cache_read_input_tokens || 0) * p.cacheRead +
      (u.cache_creation_input_tokens || 0) * p.cacheWrite) /
    1_000_000
  );
}

/** Claude Code escapes a cwd into its projects-dir name by replacing / and . with -. */
function escapeCwd(cwd) {
  return cwd.replace(/[/.]/g, "-");
}

/** Locate a thread's transcript file. The daemon threadId equals the Claude
 *  Code session id (== the .jsonl filename), so this is a direct lookup — we
 *  deliberately don't guess a sibling file when it's missing, since showing a
 *  different thread's cost is worse than showing none. */
function transcriptPath(thread, cwd) {
  if (!cwd || !/^[0-9a-f-]{8,}$/i.test(thread)) return null;
  const file = path.join(os.homedir(), ".claude", "projects", escapeCwd(cwd), `${thread}.jsonl`);
  return existsSync(file) ? file : null;
}

/** Sum token usage + cost across a thread's Claude Code transcript. Claude-only;
 *  other agents keep their transcripts elsewhere in other formats. */
function getUsage(agent, thread, cwd) {
  return cached(`usage:${agent}:${thread}`, CACHE_MS, async () => {
    if (agent !== "claude") return { available: false, reason: "unsupported-agent" };
    const file = transcriptPath(thread, cwd);
    if (!file) return { available: false, reason: "no-transcript" };
    let raw;
    try { raw = readFileSync(file, "utf8"); } catch { return { available: false, reason: "no-transcript" }; }
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
    const outByModel = new Map();
    let cost = 0, costComplete = true, messages = 0;
    for (const line of raw.split("\n")) {
      if (!line) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if (o.type !== "assistant") continue;
      const m = o.message;
      const u = m && m.usage;
      if (!u) continue;
      messages++;
      tokens.input += u.input_tokens || 0;
      tokens.output += u.output_tokens || 0;
      tokens.cacheRead += u.cache_read_input_tokens || 0;
      tokens.cacheCreation += u.cache_creation_input_tokens || 0;
      const c = msgCost(m.model, u);
      if (c == null) costComplete = false; else cost += c;
      if (m.model) outByModel.set(m.model, (outByModel.get(m.model) || 0) + (u.output_tokens || 0));
    }
    if (!messages) return { available: false, reason: "no-usage" };
    const models = [...outByModel.keys()];
    const model = models.slice().sort((a, b) => outByModel.get(b) - outByModel.get(a))[0] || null;
    const total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreation;
    return { available: true, model, models, tokens: { ...tokens, total }, cost: Math.round(cost * 100) / 100, costComplete, messages };
  });
}

// --- Available models per agent (from the daemon's model/list — the same source
// as the daemon's own /model command). Cached; models rarely change. ----------
const MODELS_CACHE_MS = 300_000;

function getModels(agent) {
  return cached(`models:${agent}`, MODELS_CACHE_MS, () =>
    probePaginated(agent, "model/list", (m) => {
      if (m?.hidden === true) return null;
      const id = m.id ?? m.model;
      if (!id) return null;
      return { id, name: m.displayName || id, description: m.description || null, isDefault: !!m.isDefault, deprecated: !!m.deprecated };
    }, { max: 10 }),
  );
}

// How many threads to keep hot in the background at once.
const WARM_THREADS = 6;
// How long a client's usage-based hint stays authoritative before we revert to
// the recency fallback (the app refreshes it every sync; this just bounds a
// stale hint from a phone that went away).
const WARM_HINT_TTL = 5 * 60_000;

// The app knows which threads this user actually opens; it ranks them (frecency
// + needs-attention) and posts the ids here via /v1/warm. Empty or expired →
// we fall back to the most-recently-active threads.
let warmHints = { at: 0, ids: [] };
function setWarmHints(ids) {
  warmHints = { at: Date.now(), ids: Array.isArray(ids) ? ids.slice(0, WARM_THREADS) : [] };
}

/**
 * Pre-warm history for the threads most likely to be opened next, so the tap
 * lands on a hot cache (a LAN round-trip) instead of a cold ~4s Iroh probe.
 * Prioritizes the app's usage-predicted hints, then fills the budget with the
 * most-recently-active threads as a fallback. `getMessages` is cached, so
 * already-warm threads return instantly and only cold ones actually probe —
 * this is self-limiting. Best-effort; runs only while a phone is connected
 * (gated by the warm-loop's lastClientSeen check).
 */
async function warmMessages(threads) {
  const live = (threads || []).filter((t) => t.isLive);
  const byId = new Map(live.map((t) => [t.id, t]));
  const picked = [];
  const seen = new Set();
  const add = (t) => { if (t && !seen.has(t.id)) { seen.add(t.id); picked.push(t); } };
  // 1) usage-predicted threads first (while the hint is fresh).
  if (Date.now() - warmHints.at < WARM_HINT_TTL) {
    for (const id of warmHints.ids) add(byId.get(id));
  }
  // 2) fall back to most-recently-active threads to fill the budget.
  for (const t of live) { if (picked.length >= WARM_THREADS) break; add(t); }
  // Low concurrency: each cold probe holds an Iroh dial for ~4s; don't stampede
  // the daemon. Warm threads short-circuit, so this rarely does real work.
  await mapLimit(picked.slice(0, WARM_THREADS), 2, async (t) => {
    try { await getMessages(t.agent, t.id); } catch {}
  });
}

function tsToIso(n) {
  if (typeof n !== "number") return null;
  return new Date(n > 1e12 ? n : n * 1000).toISOString();
}

/**
 * Derive an agent's real state from its turn history:
 *   - latest turn not completed  -> "running"
 *   - completed with a failed item/error -> "failed"
 *   - completed cleanly -> "completed" (agent finished; waiting on you)
 * Precise "awaiting input" needs a daemon stop-reason we don't have yet.
 */
function deriveActivity(turns) {
  if (!turns.length) return { activity: "idle", lastActivityAt: null };
  const last = turns[turns.length - 1];
  const lastActivityAt = tsToIso(last.completedAt) || tsToIso(last.createdAt);
  if (!last.completedAt) return { activity: "running", lastActivityAt };
  const failed =
    !!last.error || (last.items || []).some((it) => it.status === "failed" || it.success === false);
  return { activity: failed ? "failed" : "completed", lastActivityAt };
}

function threadActivity(agent, threadId) {
  return cached(`act:${threadId}`, CACHE_MS, async () => {
    try {
      return deriveActivity(await fetchTurns(agent, threadId));
    } catch {
      return { activity: "idle", lastActivityAt: null };
    }
  });
}

/** Run `fn` over `items` with at most `limit` in flight. */
async function mapLimit(items, limit, fn) {
  const q = items.slice();
  const workers = Array.from({ length: Math.min(limit, q.length) }, async () => {
    while (q.length) await fn(q.shift());
  });
  await Promise.all(workers);
}

// --- push notifications -----------------------------------------------------

const PUSH_FILE = path.join(os.homedir(), ".pounce-push-tokens.json");
const pushTokens = new Set(loadPushTokens());

function loadPushTokens() {
  try {
    return JSON.parse(readFileSync(PUSH_FILE, "utf8"));
  } catch {
    return [];
  }
}
function savePushTokens() {
  try {
    writeFileSync(PUSH_FILE, JSON.stringify([...pushTokens]));
  } catch {}
}

/** Deliver messages through Expo's push service (no auth needed). */
async function sendPush(messages) {
  if (!messages.length || typeof fetch !== "function") return;
  try {
    await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(messages),
    });
  } catch {}
}

/**
 * Background watcher: diff each live thread's activity between polls and push
 * when an agent finishes or fails. Only runs while at least one device has
 * registered a push token (so we don't poll the daemon for nothing).
 */
let prevActivity = new Map();
let watcherSeeded = false;

async function watchTick() {
  try {
    if (pushTokens.size === 0) {
      watcherSeeded = false; // re-seed when push is enabled again
      return;
    }
    cache.delete("threads"); // force fresh state for transition detection
    const threads = await getThreads();
    const snapshot = new Map(threads.map((t) => [t.id, t.activity]));

    if (watcherSeeded) {
      const messages = [];
      for (const t of threads) {
        const prev = prevActivity.get(t.id);
        const cur = t.activity;
        if (!prev || prev === cur) continue;
        const label = t.name || t.preview || t.repo || "Task";
        let note = null;
        if (cur === "completed" && prev === "running") note = { title: "✅ Task done", body: label };
        else if (cur === "failed") note = { title: "❌ Task failed", body: label };
        if (!note) continue;
        for (const to of pushTokens) {
          messages.push({
            to, sound: "default", title: note.title, body: note.body,
            data: { threadId: t.id, agent: t.agent },
          });
        }
      }
      await sendPush(messages);
    }
    prevActivity = snapshot;
    watcherSeeded = true;
  } catch {
    // swallow; try again next tick
  } finally {
    setTimeout(watchTick, WATCH_MS);
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch { resolve({}); } });
  });
}

function send(res, code, body) {
  const json = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
  });
  res.end(json);
}

let lastClientSeen = 0; // updated on every authed app request — a liveness signal
let PAIR = null;        // { ip, port, pairUrl, deepLink } — set once we're listening

/** Only the machine running the bridge may read the UI surface (it leaks the token). */
function isLoopback(req) {
  const a = req.socket.remoteAddress || "";
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

// Self-contained pairing page served at GET / (loopback only). The desktop app
// points its window here, so /ui and /qr.svg are same-origin (no CORS, and the
// port is implicit). Kept dependency-free: inline CSS + vanilla JS, no backticks
// inside so it can live in this template literal.
const UI_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Pounce Bridge</title>
<style>
:root{--bg:#faf7fb;--fg:#1a1320;--muted:#6b6472;--faint:#9a93a1;--accent:#7c3aed;--ok:#16a34a;--warn:#d97706;--border:#ece7f0}
*{box-sizing:border-box}html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased;user-select:none}
.card{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:26px 22px;gap:13px}
.brand{display:flex;align-items:center;gap:8px}.brand h1{font-size:20px;font-weight:700;margin:0;letter-spacing:-.02em}.paw{font-size:22px}
.sub{margin:0;font-size:13px;color:var(--muted)}
.qrwrap{background:#fff;border:1px solid var(--border);border-radius:18px;padding:16px;box-shadow:0 6px 24px rgba(124,58,237,.10)}
.qr{display:block;width:228px;height:228px;image-rendering:pixelated}
.addr{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--faint)}
.status{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:600}
.dot{width:9px;height:9px;border-radius:50%;background:var(--faint)}
.dot.idle{background:var(--accent);box-shadow:0 0 0 4px rgba(124,58,237,.14)}
.dot.ok{background:var(--ok);box-shadow:0 0 0 4px rgba(22,163,74,.16)}
.dot.warn{background:var(--warn);box-shadow:0 0 0 4px rgba(217,119,6,.16)}
.hint{margin:0;max-width:300px;text-align:center;font-size:12px;line-height:1.5;color:var(--muted)}
.foot{margin-top:6px;text-align:center;font-size:11px;line-height:1.6;color:var(--faint)}
.foot .ver{font-weight:600;color:var(--muted)}
.foot .os b{font-weight:600}
.foot .url{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;user-select:text}
</style></head>
<body><main class="card">
<header class="brand"><span class="paw">🐾</span><h1>Pounce&nbsp;Bridge</h1></header>
<p class="sub">Scan with your iPhone to connect</p>
<div class="qrwrap"><img id="qr" class="qr" alt="Pairing QR code"/></div>
<div class="addr" id="addr">—</div>
<div class="status"><span class="dot idle" id="dot"></span><span id="statusText">Starting…</span></div>
<p class="hint" id="hint">Open Pounce on your phone, go to Sync, and scan this code.</p>
<footer class="foot">
<div class="ver" id="ver">Pounce&nbsp;Bridge</div>
<div class="os">Runs your agents via <b>kittylitter</b>, an open-source agent host · GPL-3.0</div>
<div class="url">github.com/dnakov/litter</div>
</footer>
</main><script>
document.getElementById('qr').src = '/qr.svg?t=' + Date.now();
function set(id,t){document.getElementById(id).textContent = t;}
function tick(){
  fetch('/ui',{cache:'no-store'}).then(function(r){return r.json();}).then(function(d){
    set('addr', d.pairUrl || '-');
    var ver = 'Pounce Bridge' + (d.appVersion ? ' v' + d.appVersion : '');
    if(d.daemon && d.daemon.version) ver += '  ·  agent host v' + d.daemon.version;
    set('ver', ver);
    var dot = document.getElementById('dot');
    if(d.connected){
      var n = (d.devices && d.devices>0) ? d.devices : 1;
      dot.className='dot ok'; set('statusText','Connected - '+n+' device'+(n===1?'':'s'));
      set('hint','Your phone is talking to this computer. You are all set.');
    } else if(!d.daemonOk){
      dot.className='dot warn'; set('statusText','Starting your agent host...');
      set('hint','Waiting for the Pounce agent host to come online.');
    } else {
      dot.className='dot idle'; set('statusText','Ready to pair');
      set('hint','Open Pounce on your phone, go to Sync, and scan this code.');
    }
  }).catch(function(){ set('statusText','Starting...'); });
}
tick(); setInterval(tick, 3000);
</script></body></html>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/health") return send(res, 200, { ok: true });

  // Localhost-only UI surface for the desktop app: pairing QR + live status.
  // Gated to loopback because it exposes the pairing token.
  if (url.pathname === "/" || url.pathname === "/ui" || url.pathname === "/qr.svg") {
    if (!isLoopback(req)) return send(res, 403, { error: "local only" });
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(UI_HTML);
    }
    if (url.pathname === "/qr.svg") {
      const svg = PAIR
        ? await QRCode.toString(PAIR.deepLink, { type: "svg", margin: 1 })
        : "<svg xmlns='http://www.w3.org/2000/svg'/>";
      res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "no-store" });
      return res.end(svg);
    }
    const daemon = await status().catch(() => null);
    return send(res, 200, {
      ...(PAIR || {}),
      token: TOKEN,
      appVersion: APP_VERSION,
      daemonOk: !!(daemon && daemon.pid),
      daemon,
      devices: pushTokens.size,
      connected: lastClientSeen > 0 && Date.now() - lastClientSeen < 60_000,
      lastSeenMsAgo: lastClientSeen ? Date.now() - lastClientSeen : null,
    });
  }

  const auth = req.headers.authorization?.replace(/^Bearer\s+/i, "") || url.searchParams.get("token");
  if (auth !== TOKEN) return send(res, 401, { error: "unauthorized" });
  lastClientSeen = Date.now();

  try {
    if (url.pathname === "/v1/agents") return send(res, 200, { agents: await getAgents(url.searchParams.get("fresh") === "1") });
    if (url.pathname === "/v1/threads") return send(res, 200, { threads: await getThreads(url.searchParams.get("fresh") === "1") });
    if (url.pathname === "/v1/models") {
      const agent = url.searchParams.get("agent");
      if (!agent) return send(res, 400, { error: "agent required" });
      if (url.searchParams.get("fresh") === "1") cache.delete(`models:${agent}`);
      return send(res, 200, { models: await getModels(agent) });
    }
    if (url.pathname === "/v1/status") return send(res, 200, { status: await status() });
    if (url.pathname === "/v1/daemon" && req.method !== "POST") return send(res, 200, { daemon: await daemonInfo() });
    if (url.pathname === "/v1/daemon/restart" && req.method === "POST") {
      const info = await daemonInfo();
      // Don't kill the daemon out from under a turn unless the client insists.
      if (info.activeTurns > 0 && url.searchParams.get("force") !== "1")
        return send(res, 409, { error: "busy", daemon: info });
      return send(res, 200, { restarted: true, daemon: await restartDaemon() });
    }
    if (url.pathname === "/v1/messages") {
      const agent = url.searchParams.get("agent");
      const thread = url.searchParams.get("thread");
      if (!agent || !thread) return send(res, 400, { error: "agent and thread required" });
      const fresh = url.searchParams.get("fresh") === "1";
      return send(res, 200, { events: await getMessages(agent, thread, fresh) });
    }
    if (url.pathname === "/v1/usage") {
      const agent = url.searchParams.get("agent");
      const thread = url.searchParams.get("thread");
      const cwd = url.searchParams.get("cwd");
      if (!agent || !thread) return send(res, 400, { error: "agent and thread required" });
      if (url.searchParams.get("fresh") === "1") cache.delete(`usage:${agent}:${thread}`);
      return send(res, 200, { usage: await getUsage(agent, thread, cwd) });
    }
    if (url.pathname === "/v1/warm" && req.method === "POST") {
      // The app's ranking of which threads to keep hot (usage-predicted). We
      // pre-warm them in the background so opening one is instant.
      const body = await readBody(req);
      setWarmHints(body?.threads);
      // Warm immediately off the cached thread list so a just-updated ranking
      // doesn't wait for the next 15s tick.
      void getThreads().then(warmMessages).catch(() => {});
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/v1/turn" && req.method === "POST") {
      const body = await readBody(req);
      const { agent, threadId, text } = body;
      if (!agent || !threadId || !text) return send(res, 400, { error: "agent, threadId, text required" });
      return send(res, 200, { events: await runTurn(agent, threadId, text) });
    }
    if (url.pathname === "/v1/files") {
      const cwd = url.searchParams.get("cwd");
      const q = (url.searchParams.get("q") || "").toLowerCase();
      if (!cwd || !existsSync(cwd)) return send(res, 200, { files: [] });
      const all = await repoEntries(cwd);
      return send(res, 200, { files: rankEntries(all, q) });
    }
    if (url.pathname === "/v1/dirs") {
      // Folder browser for starting a thread in any directory. Defaults to
      // (and can't go above) $HOME; `parent` is null at the home root.
      const home = os.homedir();
      let dir = url.searchParams.get("path") || home;
      if (!existsSync(dir)) dir = home;
      let entries = [];
      try { entries = listDirs(dir); } catch { entries = []; }
      // At home or a filesystem root there is no "up" — path.dirname of a root
      // (/, C:\) returns itself, which would loop the folder browser forever.
      const up = path.dirname(dir);
      const parent = dir === home || up === dir ? null : up;
      return send(res, 200, { path: dir, parent, home, entries });
    }
    if (url.pathname === "/v1/exec" && req.method === "POST") {
      const { cwd, command } = await readBody(req);
      if (!command) return send(res, 400, { error: "command required" });
      const dir = cwd && existsSync(cwd) ? cwd : os.homedir();
      const r = IS_WIN
        ? await exec(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", command], dir, 60_000)
        : await exec("/bin/sh", ["-c", command], dir, 60_000);
      let output = (r.out || "") + (r.err ? (r.out ? "\n" : "") + r.err : "");
      if (output.length > 100_000) output = output.slice(0, 100_000) + "\n… (truncated)";
      return send(res, 200, { code: r.code, output });
    }
    if (url.pathname === "/v1/pair") {
      // The daemon's PairPayload (nodeId/relay/token) — lets the app sync
      // directly (off-LAN) instead of through this bridge.
      const inv = klInvocation();
      const r = await exec(inv.cmd, [...inv.prefix, "pair"], undefined, 15_000, KL_ENV);
      const line = (r.out || "").split("\n").find((l) => l.trim().startsWith("{"));
      try {
        const raw = line ? JSON.parse(line) : null;
        // Daemon emits snake_case; the app/native client expect camelCase.
        const pairing = raw && {
          nodeId: raw.node_id ?? raw.nodeId,
          token: raw.token,
          hostName: raw.host_name ?? raw.hostName ?? null,
          relay: raw.relay ?? null,
        };
        return send(res, 200, { pairing });
      } catch {
        return send(res, 200, { pairing: null, error: r.err || "pair failed" });
      }
    }
    if (url.pathname === "/v1/git/changes") {
      const cwd = url.searchParams.get("cwd");
      if (!cwd || !existsSync(cwd)) return send(res, 200, { branch: null, files: [], diff: "" });
      return send(res, 200, await gitChanges(cwd));
    }
    if (url.pathname === "/v1/git/commit" && req.method === "POST") {
      const { cwd, message } = await readBody(req);
      if (!cwd || !message) return send(res, 400, { error: "cwd, message required" });
      const add = await git(cwd, ["add", "-A"]);
      if (add.code !== 0) return send(res, 200, { ok: false, error: add.err || "git add failed" });
      const commit = await git(cwd, ["commit", "-m", message]);
      if (commit.code !== 0)
        return send(res, 200, { ok: false, error: commit.err || commit.out || "nothing to commit" });
      const sha = (await git(cwd, ["rev-parse", "--short", "HEAD"])).out.trim();
      cache.delete("threads");
      return send(res, 200, { ok: true, sha });
    }
    if (url.pathname === "/v1/git/push" && req.method === "POST") {
      const { cwd } = await readBody(req);
      if (!cwd) return send(res, 400, { error: "cwd required" });
      let r = await git(cwd, ["push"]);
      if (r.code !== 0 && /no upstream|set-upstream/i.test(r.err))
        r = await git(cwd, ["push", "-u", "origin", "HEAD"]);
      return send(res, 200, { ok: r.code === 0, output: (r.err || r.out).trim() });
    }
    if (url.pathname === "/v1/git/pr" && req.method === "POST") {
      const { cwd, title, body } = await readBody(req);
      if (!cwd) return send(res, 400, { error: "cwd required" });
      // Ensure the branch is pushed first, then open a PR via gh (if installed).
      let push = await git(cwd, ["push", "-u", "origin", "HEAD"]);
      const r = await exec("gh", ["pr", "create", "--fill", ...(title ? ["--title", title] : []), ...(body ? ["--body", body] : [])], cwd);
      if (r.code !== 0)
        return send(res, 200, { ok: false, error: r.err || "gh not available or PR failed", pushed: push.code === 0 });
      const urlMatch = (r.out.match(/https?:\/\/\S+/) || [])[0] || null;
      return send(res, 200, { ok: true, url: urlMatch });
    }
    if (url.pathname === "/v1/push/register" && req.method === "POST") {
      const { token } = await readBody(req);
      if (!token || !/^Expo(nent)?PushToken\[/.test(token))
        return send(res, 400, { error: "valid expo push token required" });
      if (!pushTokens.has(token)) {
        pushTokens.add(token);
        savePushTokens();
      }
      return send(res, 200, { ok: true, count: pushTokens.size });
    }
    if (url.pathname === "/v1/push/unregister" && req.method === "POST") {
      const { token } = await readBody(req);
      if (token && pushTokens.delete(token)) savePushTokens();
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/v1/turn/interrupt" && req.method === "POST") {
      const { agent, threadId } = await readBody(req);
      if (!agent || !threadId) return send(res, 400, { error: "agent, threadId required" });
      const ok = await interruptTurn(agent, threadId);
      return send(res, 200, { ok });
    }
    if (url.pathname === "/v1/turn/stream" && req.method === "POST") {
      const { agent, threadId, text, cwd, images, permissionMode, reasoningEffort, model } = await readBody(req);
      if (!agent || !text) return send(res, 400, { error: "agent, text required" });
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "access-control-allow-origin": "*",
      });
      const write = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      // Mark the bridge busy for the duration so a daemon restart won't cut the
      // turn off mid-flight (decremented exactly once, whichever end fires first).
      activeTurns++;
      let settled = false;
      const settle = () => { if (!settled) { settled = true; activeTurns = Math.max(0, activeTurns - 1); } };
      const stop = streamTurn(
        agent, threadId, text, cwd,
        (ev) => write({ event: ev }),
        (realThreadId) => {
          // The streamed turn changed this thread's history — drop the cache so
          // the app's post-turn refetch (and the next open) reads it fresh.
          if (realThreadId) {
            cache.delete(msgKey(agent, realThreadId));
            cache.delete(`usage:${agent}:${realThreadId}`); // token totals grew this turn
          }
          cache.delete("threads");
          settle();
          write({ done: true, threadId: realThreadId }); res.end();
        },
        { images, permissionMode, reasoningEffort, model },
      );
      req.on("close", () => { settle(); stop(); });
      return;
    }
    return send(res, 404, { error: "not found" });
  } catch (e) {
    return send(res, 500, { error: String(e?.message || e) });
  }
});

function localIp() {
  return Object.values(os.networkInterfaces()).flat().find((i) => i?.family === "IPv4" && !i.internal)?.address;
}

// True if something already accepts connections on the port (a running bridge).
function portInUse(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    sock.setTimeout(1500);
    sock.once("connect", () => { sock.destroy(); resolve(true); });
    sock.once("timeout", () => { sock.destroy(); resolve(false); });
    sock.once("error", () => resolve(false));
  });
}

/**
 * Start the bridge HTTP server. Resolves once listening, with the pairing info.
 * Used by both the CLI (`node server.mjs`) and the desktop app (Electrobun),
 * which calls it in-process and renders the returned deepLink as a QR.
 */
export async function startBridge({ port = PORT, quiet = false, appVersion = null } = {}) {
  if (appVersion) APP_VERSION = appVersion;
  // Never call listen() on a busy port: Bun's node:http shim throws an
  // uncatchable async error on EADDRINUSE (on top of emitting "error"), which
  // would crash the desktop app instead of falling back to the running bridge.
  if (await portInUse(port)) {
    if (!quiet) console.error(`Could not bind port ${port}: EADDRINUSE`);
    return { error: "EADDRINUSE", alreadyRunning: true, port };
  }
  return new Promise((resolve) => {
    server.once("error", (err) => {
      // A bridge is likely already running on this port — let the caller point
      // its UI at the existing instance instead of crashing.
      if (!quiet) console.error(`Could not bind port ${port}: ${err.code || err}`);
      resolve({ error: err.code || String(err), alreadyRunning: err.code === "EADDRINUSE", port });
    });
    server.listen(port, "0.0.0.0", () => {
      const ip = localIp();
      const pairUrl = `http://${ip || "localhost"}:${port}`;
      const deepLink = `pounce://connect?url=${encodeURIComponent(pairUrl)}&token=${encodeURIComponent(TOKEN)}`;
      PAIR = { ip: ip || "localhost", port, pairUrl, deepLink };
      if (!quiet) {
        console.log(`Pounce Bridge listening on ${pairUrl}`);
        console.log(`  token: ${TOKEN}`);
        console.log(`  kittylitter: ${klDisplay()}`);
        console.log("\n  📲 Scan with your iPhone Camera to pair Pounce:\n");
        qrcode.generate(deepLink, { small: true });
        console.log(`\n  …or open this link on the device:\n  ${deepLink}\n`);
      }
      // Warm the data cache so the first phone sync is instant (the probe
      // handshakes happen now, before anyone scans), then keep it warm while a
      // phone is actively connected. Idle = no probing.
      const warm = () => {
        void getAgents().catch(() => {});
        void getThreads().then(warmMessages).catch(() => {});
      };
      warm();
      setInterval(() => { if (Date.now() - lastClientSeen < 90_000) warm(); }, 15_000);
      // Keep the daemon's index fresh on its own — restart it when it falls behind
      // and nothing is busy, so recent threads surface without manual action.
      setInterval(() => { void maybeAutoRestartDaemon().catch(() => {}); }, AUTORESTART_EVERY_MS);

      setTimeout(watchTick, WATCH_MS);
      resolve({ server, token: TOKEN, kittylitter: klDisplay(), ...PAIR });
    });
  });
}

// When run directly (node server.mjs / the pounce-bridge bin), start immediately
// with the console QR. When imported (desktop app), the caller starts it.
// pathToFileURL (not string concat) so Windows paths (C:\…) compare correctly.
const isMain = (() => {
  try { return !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href; }
  catch { return false; }
})();
if (isMain) void startBridge();
