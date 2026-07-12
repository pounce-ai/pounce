#!/usr/bin/env node
/**
 * Pounce Bridge — LAN HTTP server for the Pounce apps, running on the host
 * machine. Reads coding-agent sessions straight from disk and drives the
 * agent CLIs via the native agent host (./agents). For off-LAN access it
 * spawns pounce-tunnel (apps/tunnel), an iroh p2p byte tunnel the phone
 * dials by node id — same HTTP API, any network.
 *
 *   node apps/bridge/server.mjs
 *
 * Env:
 *   BRIDGE_PORT   (default 8099)
 *   BRIDGE_TOKEN  (default: derived; printed at startup) — required by clients
 *   POUNCE_TUNNEL_BIN (path to pounce-tunnel; default ~/.pounce/bin/pounce-tunnel)
 *
 * Auth: clients send `Authorization: Bearer <BRIDGE_TOKEN>` or `?token=`.
 */
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { createReadStream, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import qrcode from "qrcode-terminal";
import QRCode from "qrcode";
import { createHost } from "./agents/host.mjs";

const IS_WIN = process.platform === "win32";

// The bridge reads agent sessions from disk and drives agent CLIs directly
// via the native agent host (./agents). Off-LAN access rides pounce-tunnel
// (apps/tunnel), an iroh p2p byte tunnel the phone dials by node id.
const PORT = Number(process.env.BRIDGE_PORT || 8099);
// How often the background watcher polls for state transitions to push.
const WATCH_MS = Number(process.env.PUSH_WATCH_MS || 25_000);
const TOKEN = process.env.BRIDGE_TOKEN || "pounce-bridge-local";
// The Bridge desktop app version, shown in the pairing window's footer. The
// desktop shell passes it to startBridge() from its package.json; env is the
// fallback for standalone `node server.mjs` runs.
let APP_VERSION = process.env.BRIDGE_APP_VERSION || null;
const host = createHost({ version: () => APP_VERSION });
const BRIDGE_STARTED_AT = new Date().toISOString();
/** /v1/daemon payload — kept shape-compatible with the old daemon report. */
function hostInfo() {
  return { running: true, pid: process.pid, startedAt: BRIDGE_STARTED_AT, uptimeSecs: Math.round(process.uptime()), activeTurns };
}
const CACHE_MS = 20_000;
const cache = new Map(); // key -> { at, value }
// Expired entries linger forever otherwise (per-thread act:/usage: keys add up
// over weeks of uptime). Every TTL in this file is ≤5min, so 15min is safely dead.
setInterval(() => {
  const cutoff = Date.now() - 15 * 60_000;
  for (const [k, v] of cache) if (v.at < cutoff) cache.delete(k);
}, 10 * 60_000).unref();

const inflight = new Map(); // key -> Promise (coalesces concurrent cache misses)

async function cached(key, ttl, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  // Coalesce: with a client syncing every ~10s and the warm loop every 15s, a
  // slow (cold-dial) probe outlives the interval — without this, every tick
  // spawned ANOTHER probe process and they accumulated unboundedly.
  const pending = inflight.get(key);
  if (pending) return pending;
  const run = (async () => {
    try {
      const value = await fn();
      cache.set(key, { at: Date.now(), value });
      return value;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, run);
  return run;
}

async function getAgents(fresh = false) {
  if (fresh) cache.delete("agents");
  return cached("agents", CACHE_MS, () => host.getAgents());
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

// Turns currently streaming through this bridge — reported by /v1/daemon and
// used for busy checks before restart-ish operations.
let activeTurns = 0;

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

async function listThreads(agent, onPage) {
  // Adapter metas carry preview already cleaned; shape + repo-fold here so the
  // thread objects keep their long-standing wire shape.
  const metas = await host.listThreads(agent).catch(() => []);
  const out = metas.map((m) => {
    const info = repoInfo(m.cwd || "");
    return {
      id: m.id,
      agent,
      cwd: m.cwd || null,
      name: m.name || null,
      preview: m.preview ?? null,
      createdAt: m.createdAt || null,
      gitBranch: m.gitBranch || null,
      modelProvider: m.modelProvider || null,
      permissionMode: m.permissionMode || null,
      repo: info.repo,
      worktree: info.worktree,
      isWorktree: info.isWorktree,
      isLive: info.isLive,
    };
  });
  if (onPage) {
    for (let i = 0; i < out.length; i += 100) await onPage(out.slice(i, i + 100));
  }
  return out;
}

/** Stream threads to `sink` page-by-page as the daemon paginates — same per-thread
 *  shaping getThreads does (provisional activity + worktree→repo fold), applied
 *  per page so the app can render progressively instead of blocking on every
 *  cold-dial page. */
async function streamThreads(sink) {
  const agents = await getAgents();
  const avail = agents.filter((a) => a.available && a.wire === "jsonl" && a.id !== "shell");
  for (const a of avail) {
    await listThreads(a.id, async (page) => {
      for (const t of page) {
        t.activity = t.isLive ? "idle" : "completed";
        t.lastActivityAt = t.createdAt;
      }
      await resolveWorktreeRepos(page);
      await sink(page);
    });
  }
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
  return cached("status", CACHE_MS, () => host.status());
}

/**
 * Run a turn on the host (the agent actually executes), wait for completion,
 * then re-read the thread so the new user message + agent reply are returned.
 * Re-reading is more robust than parsing the streaming notifications.
 */
async function runTurn(agent, threadId, text) {
  const realId = await host.startTurn(agent, { threadId, text }).done;
  cache.delete("threads");
  return getMessages(agent, realId || threadId, true);
}

function interruptTurn(agent, threadId) {
  return Promise.resolve(host.interrupt(agent, threadId));
}

/** Run a turn, streaming its timeline events to `onEvent`; `onDone` fires
 *  exactly once with the real thread id. Returns a stop() to abort. */
function streamTurn(agent, threadId, text, cwd, onEvent, onDone, opts = {}) {
  const t = host.startTurn(agent, { threadId, text, cwd, ...opts }, onEvent);
  void t.done.then((realId) => onDone(realId || threadId));
  return () => t.stop();
}

async function getMessages(agent, threadId, fresh = false, limit) {
  // The host keeps parsed histories in a hard-capped LRU that its fs watcher
  // invalidates the moment a transcript changes.
  return host.getEvents(agent, threadId, { limit, fresh });
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
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
    const outByModel = new Map();
    let cost = 0, costComplete = true, messages = 0;
    // Stream the transcript line-by-line — reading a multi-million-token thread's
    // JSONL fully into memory (readFileSync + split) is a large, avoidable spike.
    let rl;
    try {
      rl = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
    } catch { return { available: false, reason: "no-transcript" }; }
    for await (const line of rl) {
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
  return cached(`models:${agent}`, MODELS_CACHE_MS, () => host.listModels(agent));
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

function threadActivity(agent, threadId) {
  return cached(`act:${threadId}`, CACHE_MS, () => host.getActivity(agent, threadId));
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
/* Connected: a gentle "breathing" glow so it reads as live, not frozen. */
.dot.ok{background:var(--ok);animation:breathe 2.4s ease-in-out infinite}
/* Syncing right now: faster accent pulse. */
.dot.sync{background:var(--accent);animation:breathe-a .9s ease-in-out infinite}
.dot.warn{background:var(--warn);box-shadow:0 0 0 4px rgba(217,119,6,.16)}
@keyframes breathe{0%,100%{box-shadow:0 0 0 3px rgba(22,163,74,.18)}50%{box-shadow:0 0 0 8px rgba(22,163,74,.04)}}
@keyframes breathe-a{0%,100%{box-shadow:0 0 0 3px rgba(124,58,237,.28)}50%{box-shadow:0 0 0 8px rgba(124,58,237,.06)}}
/* Indeterminate progress bar — an accent segment sweeps while the phone syncs. */
.syncbar{width:190px;height:4px;border-radius:3px;background:var(--border);overflow:hidden;opacity:0;transition:opacity .25s;margin-top:-2px}
.syncbar.on{opacity:1}
.syncbar>i{display:block;height:100%;width:38%;border-radius:3px;background:linear-gradient(90deg,rgba(124,58,237,.15),var(--accent),rgba(124,58,237,.15));animation:sweep 1.05s cubic-bezier(.5,0,.5,1) infinite}
@keyframes sweep{0%{transform:translateX(-110%)}100%{transform:translateX(295%)}}
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
<div class="syncbar" id="syncbar"><i></i></div>
<p class="hint" id="hint">Open Pounce on your phone, go to Sync, and scan this code.</p>
<footer class="foot">
<div class="ver" id="ver">Pounce&nbsp;Bridge</div>
<div class="os">Agents run natively · off-LAN sync via <b>iroh</b> p2p</div>
<div class="url">github.com/n0-computer/iroh</div>
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
    var bar = document.getElementById('syncbar');
    if(d.connected){
      var n = (d.devices && d.devices>0) ? d.devices : 1;
      if(d.syncing){
        // Phone is actively talking to us right now — show the progress sweep.
        dot.className='dot sync'; bar.className='syncbar on';
        set('statusText','Syncing…');
        set('hint','Your phone is syncing with this computer…');
      } else {
        dot.className='dot ok'; bar.className='syncbar';
        set('statusText','Connected - '+n+' device'+(n===1?'':'s'));
        set('hint','Your phone is talking to this computer. You are all set.');
      }
    } else if(!d.daemonOk){
      dot.className='dot warn'; bar.className='syncbar'; set('statusText','Starting your agent host...');
      set('hint','Waiting for the Pounce agent host to come online.');
    } else {
      dot.className='dot idle'; bar.className='syncbar'; set('statusText','Ready to pair');
      set('hint','Open Pounce on your phone, go to Sync, and scan this code.');
    }
  }).catch(function(){ set('statusText','Starting...'); });
}
tick(); setInterval(tick, 1200);
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
      // "actively talking" — a request landed in the last few seconds, i.e. the
      // phone is connecting / syncing right now. Drives the live sync animation.
      syncing: lastClientSeen > 0 && Date.now() - lastClientSeen < 2500,
      lastSeenMsAgo: lastClientSeen ? Date.now() - lastClientSeen : null,
    });
  }

  const auth = req.headers.authorization?.replace(/^Bearer\s+/i, "") || url.searchParams.get("token");
  if (auth !== TOKEN) return send(res, 401, { error: "unauthorized" });
  lastClientSeen = Date.now();
  if (process.env.BRIDGE_DEBUG) console.log(`[req] ${req.method} ${url.pathname}${url.search}`);

  try {
    if (url.pathname === "/v1/agents") return send(res, 200, { agents: await getAgents(url.searchParams.get("fresh") === "1") });
    if (url.pathname === "/v1/threads") return send(res, 200, { threads: await getThreads(url.searchParams.get("fresh") === "1") });
    // SSE variant: emit each page of threads as it arrives so the app's initial
    // connect renders progressively instead of blocking ~a minute on all the
    // cold-dial pages. `data: {threads:[...]}` per page, then `data: {done:true}`.
    if (url.pathname === "/v1/threads/stream") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "access-control-allow-origin": "*",
      });
      const write = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      let closed = false;
      req.on("close", () => { closed = true; });
      try {
        await streamThreads((page) => { if (!closed) write({ threads: page }); });
        if (!closed) write({ done: true });
      } catch (e) {
        if (!closed) write({ error: String(e?.message || e) });
      }
      return res.end();
    }
    if (url.pathname === "/v1/models") {
      const agent = url.searchParams.get("agent");
      if (!agent) return send(res, 400, { error: "agent required" });
      if (url.searchParams.get("fresh") === "1") cache.delete(`models:${agent}`);
      return send(res, 200, { models: await getModels(agent) });
    }
    if (url.pathname === "/v1/status") return send(res, 200, { status: await status() });
    if (url.pathname === "/v1/daemon" && req.method !== "POST") {
      return send(res, 200, { daemon: hostInfo() });
    }
    if (url.pathname === "/v1/daemon/restart" && req.method === "POST") {
      // Nothing external to restart anymore — the host reads straight from disk.
      // Honor the app's Restart action by dropping every cache instead.
      cache.clear();
      return send(res, 200, { restarted: true, daemon: hostInfo() });
    }
    if (url.pathname === "/v1/messages") {
      const agent = url.searchParams.get("agent");
      const thread = url.searchParams.get("thread");
      if (!agent || !thread) return send(res, 400, { error: "agent and thread required" });
      const fresh = url.searchParams.get("fresh") === "1";
      const limit = Number(url.searchParams.get("limit")) || undefined;
      return send(res, 200, { events: await getMessages(agent, thread, fresh, limit) });
    }
    if (url.pathname === "/v1/image") {
      const agent = url.searchParams.get("agent");
      const thread = url.searchParams.get("thread");
      const ref = url.searchParams.get("ref");
      if (!agent || !thread || !ref) return send(res, 400, { error: "agent, thread, ref required" });
      const img = await host.getImage(agent, thread, ref).catch(() => null);
      if (!img) return send(res, 404, { error: "image not found" });
      res.writeHead(200, {
        "content-type": img.mediaType,
        "cache-control": "private, max-age=86400",
        "access-control-allow-origin": "*",
      });
      res.end(img.buffer);
      return;
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
      // PairPayload for off-LAN access: pounce-tunnel's Iroh identity (written
      // to ~/.pounce/tunnel.json at its startup) + this bridge's token. The
      // phone dials the tunnel by node id and speaks this same HTTP API.
      try {
        const info = JSON.parse(readFileSync(path.join(os.homedir(), ".pounce", "tunnel.json"), "utf8"));
        return send(res, 200, {
          pairing: info?.nodeId
            ? { nodeId: info.nodeId, token: TOKEN, hostName: os.hostname().replace(/\.local$/, ""), relay: info.relay || null }
            : null,
        });
      } catch {
        return send(res, 200, { pairing: null, error: "tunnel not running" });
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
  // Idempotent: when this file is bundled into a launcher, the `isMain`
  // self-start below and the launcher's explicit call both fire — the second
  // one must not listen() again.
  if (startBridge._started) return { alreadyRunning: true, port, ...(PAIR || {}) };
  startBridge._started = true;
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
        console.log("  agents: native host");
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
      setTimeout(watchTick, WATCH_MS);
      ensureTunnel();
      resolve({ server, token: TOKEN, ...PAIR });
    });
  });
}

// --- pounce-tunnel (off-LAN access) -------------------------------------------
// The Rust tunnel (apps/tunnel) accepts Iroh QUIC streams from the phone and
// proxies them to this bridge, so the app works from anywhere. Its identity
// lands in ~/.pounce/tunnel.json, which /v1/pair serves. Best-effort: no
// binary → LAN-only, exactly as before.
function tunnelBinary() {
  const candidates = [
    process.env.POUNCE_TUNNEL_BIN,
    path.join(os.homedir(), ".pounce", "bin", IS_WIN ? "pounce-tunnel.exe" : "pounce-tunnel"),
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) || null;
}

let tunnelChild = null;
let tunnelBackoffMs = 1000;
function ensureTunnel() {
  if (tunnelChild) return;
  const bin = tunnelBinary();
  if (!bin) return; // no tunnel installed — LAN-only
  try {
    tunnelChild = spawn(bin, ["serve", "--token", TOKEN, "--target", `127.0.0.1:${PORT}`],
      { stdio: ["ignore", "ignore", "ignore"], windowsHide: true });
    tunnelChild.on("close", () => {
      tunnelChild = null;
      // Respawn with backoff — a crashing tunnel must not loop hot.
      setTimeout(ensureTunnel, Math.min(tunnelBackoffMs *= 2, 60_000)).unref();
    });
    tunnelChild.on("spawn", () => { tunnelBackoffMs = 1000; });
    console.log(`[tunnel] started ${bin}`);
  } catch {
    tunnelChild = null;
  }
}
process.on("exit", () => { try { tunnelChild?.kill("SIGTERM"); } catch {} });

// When run directly (node server.mjs / the pounce-bridge bin), start immediately
// with the console QR. When imported (desktop app), the caller starts it.
// pathToFileURL (not string concat) so Windows paths (C:\…) compare correctly.
const isMain = (() => {
  try { return !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href; }
  catch { return false; }
})();
if (isMain) void startBridge();
