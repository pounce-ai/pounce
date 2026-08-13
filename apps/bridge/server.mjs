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
import { createHash } from "node:crypto";
import { gzip } from "node:zlib";
import { execFileSync, spawn } from "node:child_process";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import qrcode from "qrcode-terminal";
import QRCode from "qrcode";
import { createHost } from "./agents/host.mjs";
import {
  clearThreadMarkers,
  listMarkers,
  replaceThreadMarkers,
  setMarker,
} from "./agents/markers.mjs";
import { baseName, createWorktreeIndex, normPath } from "./agents/worktrees.mjs";
import { toAtif } from "./agents/atif.mjs";
import { resolvePermission } from "./agents/acp.mjs";
import {
  startInteractiveSession,
  answerPrompt,
  pendingPrompt,
  isInteractive,
  sendInput,
} from "./agents/pty-turn.mjs";
import { ptyNative } from "./agents/pty.mjs";
import { agentEnv, binPath, binVersion, primaryLanIp } from "./agents/env.mjs";
import { publicConfig, readConfig, writeConfig } from "./agents/config.mjs";
import { LEGACY_TOKEN, bridgeToken, legacyAllows, tokenMatches } from "./agents/token.mjs";
import { hostIsAddress } from "./agents/host-guard.mjs";
import { createDevices } from "./agents/devices.mjs";
import { bridgeId as machineBridgeId } from "./agents/identity.mjs";
import { createDiscovery } from "./agents/discovery.mjs";
import {
  createAccess,
  grantAllowsRoute,
  normalizeScope,
  pathInScope,
  resolveScope,
} from "./agents/access.mjs";
import { readContextFiles, writeContextFile } from "./agents/context.mjs";
import { createHistorySearch } from "./agents/search.mjs";
import { createActivityIndex } from "./agents/activity-index.mjs";
import { readQuota } from "./agents/quota.mjs";
import { readBlocks } from "./agents/blocks.mjs";
import { dailyCost, resetCostCache } from "./agents/admin-cost.mjs";
import {
  dailyCost as estimatedDailyCost,
  dailyUsage as ccusageDailyUsage,
  SUPPORTED as ccusageReads,
  resetCcusageCache,
} from "./agents/ccusage.mjs";
import { listSettled, setSettled } from "./agents/settled.mjs";
import { mergeBilledCost, mergeEstimatedCost, mergeTokens } from "./agents/series-overlay.mjs";
import { listEditors, openIn } from "./agents/editors.mjs";
import { closeShell, getShell, killAllShells, openShell, reapShells } from "./agents/term.mjs";
import {
  cancelSshBootstrap,
  getSshBootstrap,
  killAllSshBootstraps,
  startSshBootstrap,
} from "./agents/ssh.mjs";
import {
  compareVersions,
  ensureTunnelBinary,
  fetchTunnel,
  lastTunnelError,
  latestTunnelRelease,
  rollbackTunnel,
  tunnelBinary,
  tunnelVersion,
} from "./agents/tunnel-bin.mjs";
import { runTunnelUpdate } from "./agents/tunnel-update.mjs";
import {
  rememberActivity,
  seedActivity as seedFromMemo,
} from "./agents/activity-memo.mjs";
import { listSshHosts } from "./agents/ssh-hosts.mjs";

const IS_WIN = process.platform === "win32";

// The bridge reads agent sessions from disk and drives agent CLIs directly
// via the native agent host (./agents). Off-LAN access rides pounce-tunnel
// (apps/tunnel), an iroh p2p byte tunnel the phone dials by node id.
const DEFAULT_PORT = 8099;
const PORT = Number(process.env.BRIDGE_PORT || DEFAULT_PORT);
// How often the background watcher polls for state transitions to push.
const WATCH_MS = Number(process.env.PUSH_WATCH_MS || 25_000);
const { token: TOKEN, legacyUntil: LEGACY_UNTIL } = bridgeToken();
// The Bridge desktop app version, shown in the pairing window's footer. The
// desktop shell passes it to startBridge() from its package.json; env is the
// fallback for standalone `node server.mjs` runs.
let APP_VERSION = process.env.BRIDGE_APP_VERSION || null;
const host = createHost({ version: () => APP_VERSION });
// Full-text history search (ctx-backed). When ctx is missing, bootstrap it
// automatically — pinned release, checksum-verified, dropped in ~/.pounce/bin
// like pounce-tunnel. POUNCE_NO_CTX_INSTALL=1 opts out; /v1/search then 501s.
const historySearch = createHistorySearch();
if (historySearch.available()) historySearch.refresh();
else if (process.env.POUNCE_NO_CTX_INSTALL !== "1") void historySearch.ensureInstalled();
const BRIDGE_STARTED_AT = new Date().toISOString();
/** /v1/daemon payload — kept shape-compatible with the old daemon report. */
function hostInfo() {
  return {
    running: true,
    pid: process.pid,
    startedAt: BRIDGE_STARTED_AT,
    uptimeSecs: Math.round(process.uptime()),
    activeTurns,
  };
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
  // slow refresh outlives the interval — without this, every tick started
  // ANOTHER one and they accumulated unboundedly.
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

/** Run a command, capturing exit code + stdout + stderr. Optional kill
 *  timeout; optional `input` is written to stdin. */
function exec(cmd, args, cwd, timeoutMs = 0, env = undefined, input = undefined) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: [input != null ? "pipe" : "ignore", "pipe", "pipe"],
    });
    let out = "",
      err = "",
      killed = false;
    const timer = timeoutMs
      ? setTimeout(() => {
          killed = true;
          p.kill("SIGKILL");
        }, timeoutMs)
      : null;
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, out, err: err + (killed ? "\n[command timed out]" : "") });
    });
    p.on("error", (e) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, out: "", err: String(e?.message || e) });
    });
    if (input != null) {
      p.stdin.write(input);
      p.stdin.end();
    }
  });
}

/** Cap a diff's size, appending the marker the client strips as an exact line
 *  (packages/app diffPatch.splitPatch matches it verbatim — keep in sync). */
const DIFF_TRUNCATED_MARKER = "… (diff truncated)";
function truncateDiff(text, max) {
  return text.length > max ? `${text.slice(0, max)}\n${DIFF_TRUNCATED_MARKER}` : text;
}
const git = (cwd, args) => exec("git", ["-C", cwd, ...args]);

// Turns currently streaming through this bridge — reported by /v1/daemon and
// used for busy checks before restart-ish operations.
let activeTurns = 0;

/** Uncommitted changes in `cwd`: branch, per-file status + counts, full diff,
 *  plus ahead/behind vs upstream and the count of conflicted files. */
async function gitChanges(cwd) {
  const [numstat, status, diff, branch, upstream] = await Promise.all([
    git(cwd, ["diff", "HEAD", "--numstat"]),
    git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]),
    git(cwd, ["-c", "core.quotepath=false", "diff", "HEAD"]),
    git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
    git(cwd, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]),
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
  let conflicts = 0;
  for (const line of status.out.split("\n").filter(Boolean)) {
    const code = line.slice(0, 2);
    const p = line.slice(3).replace(/^"|"$/g, "");
    // Unmerged-path XY codes (git-status(1)): both-modified, both-added, etc.
    if (["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(code)) conflicts++;
    let st = "modified";
    if (code.includes("?")) st = "untracked";
    else if (code.includes("A")) st = "added";
    else if (code.includes("D")) st = "deleted";
    else if (code.includes("R")) st = "renamed";
    files.push({ path: p, status: st, ...(counts[p] || { additions: 0, deletions: 0 }) });
  }
  const diffText = truncateDiff(diff.out, 200_000);
  // "behind\tahead" relative to upstream; no upstream → nulls.
  const [behind, ahead] =
    upstream.code === 0
      ? upstream.out
          .trim()
          .split(/\s+/)
          .map((n) => Number(n) || 0)
      : [null, null];
  return { branch: branch.out.trim(), files, diff: diffText, ahead, behind, conflicts };
}

/**
 * Model-generated git metadata for the working tree: branch name, commit
 * message, PR title + body. Runs the host's claude CLI in print mode over the
 * diff (cheap model). The client must show the result for user approval before
 * acting on any of it — nothing here mutates the repo.
 */
async function gitSuggest(cwd) {
  const [diff, status, branch, log] = await Promise.all([
    git(cwd, ["-c", "core.quotepath=false", "diff", "HEAD"]),
    git(cwd, ["status", "--porcelain=v1"]),
    git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
    git(cwd, ["log", "--oneline", "-8"]),
  ]);
  const diffText = truncateDiff(diff.out, 60_000);
  if (!status.out.trim() && !diffText.trim()) return { ok: false, error: "no changes to describe" };
  const prompt = [
    "You generate git metadata. Reply with ONLY a JSON object (no fences, no prose):",
    '{"branchName": string, "commitMessage": string, "prTitle": string, "prBody": string}',
    "- branchName: short kebab-case, describes the work (no user/prefix).",
    "- commitMessage: imperative summary line ≤72 chars; optionally a blank line + short body.",
    "- prTitle: ≤70 chars.",
    "- prBody: brief markdown — what changed and why, a few bullets max.",
    "Match the tone of the recent commit subjects.",
    "",
    `Current branch: ${branch.out.trim()}`,
    `Recent commits:\n${log.out.trim()}`,
    `git status:\n${status.out.trim()}`,
    `Diff:\n${diffText}`,
  ].join("\n");
  // Run from the OS temp dir, not the repo: claude -p records a session under
  // its cwd's project, which would surface these one-shot calls as threads.
  const run = await exec(
    binPath("claude"),
    ["-p", "--model", "haiku"],
    os.tmpdir(),
    90_000,
    agentEnv(),
    prompt,
  );
  if (run.code !== 0) return { ok: false, error: (run.err || "claude CLI failed").slice(0, 400) };
  const body = run.out
    .replace(/^```(?:json)?/m, "")
    .replace(/```\s*$/m, "")
    .trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  try {
    const s = JSON.parse(body.slice(start, end + 1));
    const clean = (v) => (typeof v === "string" ? v.trim() : "");
    return {
      ok: true,
      branchName: clean(s.branchName)
        .replace(/[^a-zA-Z0-9._/-]+/g, "-")
        .replace(/^-+|-+$/g, ""),
      commitMessage: clean(s.commitMessage),
      prTitle: clean(s.prTitle),
      prBody: clean(s.prBody),
    };
  } catch {
    return { ok: false, error: "model returned unparseable output" };
  }
}

/**
 * CI status for the branch's open PR via the gh CLI. Summarised to one word so
 * the client renders a single row. null checks = no PR / gh missing / timeout —
 * the row simply doesn't render.
 */
async function gitChecks(cwd) {
  const r = await exec("gh", ["pr", "checks", "--json", "state"], cwd, 8000);
  // gh exits non-zero when any check fails but still prints JSON — parse regardless.
  try {
    const arr = JSON.parse(r.out);
    if (!Array.isArray(arr) || !arr.length) return { checks: null, failed: 0, total: 0 };
    const states = arr.map((c) => String(c.state || "").toUpperCase());
    const failed = states.filter((s) =>
      ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"].includes(s),
    ).length;
    const pending = states.filter((s) =>
      ["PENDING", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED", "EXPECTED"].includes(s),
    ).length;
    const checks = failed ? "failing" : pending ? "pending" : "passing";
    return { checks, failed, total: states.length };
  } catch {
    return { checks: null, failed: 0, total: 0 };
  }
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
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
    }
    if (!isDir) continue;
    out.push({ name: d.name, path: full, isRepo: existsSync(path.join(full, ".git")) });
  }
  out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return out;
}

/**
 * Resolve a working directory into repo grouping + worktree info.
 *
 * PROVISIONAL: the repo here is just the directory's own basename, because no
 * amount of path parsing reliably identifies the repo a directory belongs to.
 * Worktree layouts are per-tool conventions — superset writes
 * `~/.superset/worktrees/<workspace>/<name>`, Claude Code writes
 * `<repo>/.claude/worktrees/<name>`, a hand-run `git worktree add` writes
 * wherever it was pointed — so a regex for one of them was always going to
 * mislabel the others. resolveWorktreeOwners() rewrites `repo` from git's own
 * records; this only has to be sane for what git can't account for.
 *
 * `isLive` = the directory still exists, i.e. the thread can be RESUMED.
 * Not "is running" and not "is recent": it is true for almost every thread
 * forever. The app calls it `isResumable` for that reason (three bugs came from
 * reading this name as activity); the wire keeps `isLive` so a phone on an
 * older build still understands a new bridge.
 */
function repoInfo(cwd) {
  const p = normPath(cwd);
  // Drive roots (C:\) count as root too; normPath has already dropped the slash.
  const isRoot = !p || /^[A-Za-z]:$/.test(p);
  // Scratch sessions (homedir/root) are resumable like any other as long as the
  // directory exists — hardcoding isLive:false made every scratch thread
  // read-only ("archived") the moment it finished, forcing a NEW session per
  // follow-up instead of reusing the one thread.
  const live = !!cwd && existsSync(cwd);
  if (!cwd || isRoot || cwd === os.homedir()) {
    return { repo: "Scratch", isWorktree: false, isLive: live, worktree: null };
  }
  return { repo: baseName(p), isWorktree: false, isLive: live, worktree: null };
}

// Worktree sessions must group under the project they were cut from, and that
// question outlives the directory — see agents/worktrees.mjs for why it is asked
// repo-side rather than by parsing paths.
const worktreeIndex = createWorktreeIndex({ git });
const resolveWorktreeOwners = (threads) => worktreeIndex.resolve(threads);

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
 *  per page so the app can render progressively instead of blocking until the
 *  whole list is built. */
async function streamThreads(sink) {
  const seen = [];
  const agents = await getAgents();
  // Same as getThreads: list threads for every JSONL agent that has sessions on
  // disk — NOT gated on `a.available`. History is viewable without a runnable CLI
  // (codex shadowed by a wrapper, not on the GUI app's PATH, …); the CLI is only
  // needed to RUN turns. The desktop app syncs via THIS streaming path, so the
  // filter has to match or codex/etc. threads never reach it.
  const avail = agents.filter((a) => a.wire === "jsonl" && a.id !== "shell");
  for (const a of avail) {
    await listThreads(a.id, async (page) => {
      for (const t of page) seedActivity(t);
      await resolveWorktreeOwners(page);
      // Only LIVE threads, because only those get enriched below — keeping
      // every thread from every agent alive for the length of a stream is the
      // retention this paged path exists to avoid.
      for (const t of page) if (t.isLive) seen.push(t);
      await sink(page);
    });
  }
  // This path used to be the ONE that never read real activity: a client that
  // syncs by streaming (the desktop's connect) saw every thread as idle or
  // completed forever. Enriching afterwards can't help the pages already sent,
  // but it fills lastKnownActivity so the next sync — by either path — is right.
  //
  // Newest first, matching getThreads, because enrichThreadActivity reads only
  // the first 30 and runs one pass at a time. Left in per-agent listing order
  // this pass would spend the only slot on whichever threads the first agent
  // happened to return, and the concurrent poll — which wanted the newest —
  // would find the door shut and skip.
  seen.sort((x, y) => (y.createdAt || "").localeCompare(x.createdAt || ""));
  void enrichThreadActivity(seen);
}

async function getThreads(fresh = false) {
  if (fresh) cache.delete("threads");
  return cached("threads", CACHE_MS, async () => {
    const agents = await getAgents(fresh);
    // List threads for every available JSONL agent (codex, claude, opencode,
    // hermes, …). `shell` has no threads. This replaces a hardcoded allowlist
    // that omitted codex (and amp/pi/grok/…).
    // List threads for every JSONL agent that has sessions on disk — NOT gated
    // on `a.available`. You can VIEW an agent's history without a runnable CLI
    // (e.g. `codex` shadowed by a wrapper, or not on the GUI app's PATH); the CLI
    // is only needed to RUN new turns (gated in startTurn). Empty dirs cost nothing.
    const avail = agents.filter((a) => a.wire === "jsonl" && a.id !== "shell");
    const lists = await Promise.all(avail.map((a) => listThreads(a.id).catch(() => [])));
    const threads = lists
      .flat()
      .sort((x, y) => (y.createdAt || "").localeCompare(x.createdAt || ""));

    // Fold worktree sessions into their real origin repo before clients see the
    // list (cheap: one git call per unresolved workspace, then cached).
    await resolveWorktreeOwners(threads);

    // Provisional activity so the list returns fast — real activity is filled in
    // asynchronously below.
    for (const t of threads) seedActivity(t);

    // Enrich live threads with real activity from their turn history in the
    // background rather than blocking the list on it. We mutate these same
    // objects in place; since the cache holds these references, the next poll
    // (the app refreshes on an interval) serves the enriched data.
    void enrichThreadActivity(threads);
    return threads;
  });
}

/** A PTY-hosted session blocked on an interactive prompt (trust / permission /
 *  plan / question) is "awaiting_input", whatever its transcript says — the
 *  turn looks idle on disk while the CLI sits on a menu. This is what lets the
 *  app rank the thread "needs you" and alert instead of showing it idle. */
function flagAwaitingPrompt(t) {
  if (pendingPrompt(t.id)) t.activity = "awaiting_input";
}

/**
 * The last real activity reading per thread, carried across list rebuilds.
 *
 * The rules for what may be remembered — and why a transient state must not be —
 * live in agents/activity-memo.mjs, where they can be tested without a bridge.
 */
const lastKnownActivity = new Map();

function seedActivity(t) {
  seedFromMemo(lastKnownActivity, t);
  flagAwaitingPrompt(t);
}

let enrichInFlight = false;
function enrichThreadActivity(threads) {
  if (enrichInFlight) return;
  enrichInFlight = true;
  const liveThreads = threads.filter((t) => t.isLive).slice(0, 30);
  return mapLimit(liveThreads, 4, async (t) => {
    try {
      const a = await threadActivity(t.agent, t.id);
      if (a.activity) {
        t.activity = a.activity;
        if (a.lastActivityAt) t.lastActivityAt = a.lastActivityAt;
        // Only settled readings are kept; see activity-memo.
        rememberActivity(lastKnownActivity, t, a);
      }
      flagAwaitingPrompt(t); // a pending prompt outranks transcript-derived state
    } catch {}
  }).finally(() => {
    enrichInFlight = false;
  });
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
  historySearch.refresh();
  return getMessages(agent, realId || threadId, true);
}

function interruptTurn(agent, threadId) {
  return Promise.resolve(host.interrupt(agent, threadId));
}

/** Run a turn, streaming its timeline events to `onEvent`; `onDone` fires
 *  exactly once with the real thread id. Returns a stop() to abort. */
function streamTurn(agent, threadId, text, cwd, onEvent, onDone, opts = {}) {
  const t = host.startTurn(agent, { threadId, text, cwd, ...opts }, onEvent);
  // onDone must fire even when the turn errors — otherwise the client stream
  // never gets its terminal frame and the busy marker leaks.
  void t.done.then(
    (realId) => {
      historySearch.refresh();
      onDone(realId || threadId);
    },
    () => onDone(threadId),
  );
  return () => t.stop();
}

async function getMessages(agent, threadId, fresh = false, limit) {
  // The host keeps parsed histories in a hard-capped LRU that its fs watcher
  // invalidates the moment a transcript changes.
  const events = await host.getEvents(agent, threadId, { limit, fresh });
  // A PTY-hosted interactive session blocked on ANY prompt (trust / permission /
  // plan / AskUserQuestion / menu) → append a synthesized prompt_request so the
  // app can render an answerable card. Detected generically from the screen, so
  // it's null for non-interactive sessions and clears once the prompt is gone.
  const pp = pendingPrompt(threadId);
  if (!pp) return events;
  // `events` is the host's CACHED array — never push onto it (that would append
  // a fresh prompt_request every poll and pile up duplicate keys in the app's
  // list). Return a new array with the synthesized event tacked on.
  const lastSeq = events.length ? events[events.length - 1].seq || 0 : 0;
  return [
    ...events,
    {
      id: `prompt:${pp.promptId}`,
      conversationId: threadId,
      seq: lastSeq + 1,
      ts: new Date().toISOString(),
      type: "prompt_request",
      promptId: pp.promptId,
      title: pp.title,
      kind: pp.kind,
      options: pp.options,
      highlighted: pp.highlighted,
      multiSelect: pp.multiSelect,
    },
  ];
}

// --- Per-thread token usage ------------------------------------------------
// Owned by the adapters now (agents/usage.mjs): each one reads its own agent's
// records, and a dollar figure is reported ONLY when that agent itself states
// one. The price table that used to live here — which multiplied tokens by
// hardcoded per-model rates — was deliberately deleted: it silently drifted
// from real billing and presented an estimate as fact.
function getUsage(agent, thread) {
  return cached(`usage:${agent}:${thread}`, CACHE_MS, () =>
    host.getUsage(agent, thread).catch(() => ({ available: false, reason: "unavailable" })),
  );
}

// --- Daily activity series (the dashboard) ---------------------------------
// Token counts get a DATE attached by scanning the agents' own transcripts;
// dollars come only from the cost ledger, i.e. figures an agent reported. See
// agents/activity-index.mjs — nothing here prices a token.
const activity = createActivityIndex({
  resolveFile: (agent, thread) => host.transcriptFile(agent, thread),
});

// How often the background pass re-reads transcripts that changed. The index is
// mtime-keyed, so a tick over unchanged threads is one stat() each.
const ACTIVITY_POPULATE_MS = Number(process.env.ACTIVITY_POPULATE_MS || 10 * 60_000);

/**
 * The three per-day overlays, each just a fetch now.
 *
 * The merges — and the precedence each one encodes — live in
 * agents/series-overlay.mjs, where they are pure and tested. What stays here is
 * only the I/O and the ORDER, which is itself a rule: estimate before billing,
 * so the org's report sits on top of both.
 */
async function withCcusageTokens(series, since) {
  const usage = await ccusageDailyUsage({ since }).catch(() => ({ available: false }));
  if (!usage.available) return series;
  return mergeTokens(series, usage.byDay || {}, ccusageReads);
}

async function withEstimatedCost(series, days, since) {
  // Same `since` the token read used, so both share one ccusage run.
  const est = await estimatedDailyCost({ days, since }).catch(() => ({ available: false }));
  if (!est.available) return series;
  return mergeEstimatedCost(series, est.byDay || {});
}

/** Opt-in: needs an Admin API key in ~/.pounce/config.json. */
async function withAdminCost(series, days) {
  const apiKey = readConfig().adminApiKey;
  if (!apiKey) return series;
  const report = await dailyCost(apiKey, { days }).catch(() => ({ available: false }));
  if (!report.available) return series;
  return mergeBilledCost(series, report.byDay || {});
}

/**
 * Keep the activity index warm in the background.
 *
 * Without this the FIRST dashboard open pays a full cold scan of every
 * transcript on the host — tens of seconds on a machine with real history —
 * and pays it again after each bridge restart. The index persists to
 * ~/.pounce/activity-cache.json, so populating it once off the critical path
 * makes the dashboard open instantly and stay current as turns land.
 *
 * Deliberately unconditional (not gated on a connected phone, unlike the warm
 * loop): the point is that the data is READY when someone finally opens the
 * tab. It is cheap to repeat — unchanged transcripts cost a stat() — and the
 * first pass is delayed so it never competes with startup.
 */
function startActivityPopulate() {
  const pass = () =>
    getThreads()
      .then((threads) => activity.populate(threads))
      .catch(() => {});
  setTimeout(pass, 20_000).unref();
  setInterval(pass, ACTIVITY_POPULATE_MS).unref();
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
  const add = (t) => {
    if (t && !seen.has(t.id)) {
      seen.add(t.id);
      picked.push(t);
    }
  };
  // 1) usage-predicted threads first (while the hint is fresh).
  if (Date.now() - warmHints.at < WARM_HINT_TTL) {
    for (const id of warmHints.ids) add(byId.get(id));
  }
  // 2) fall back to most-recently-active threads to fill the budget.
  for (const t of live) {
    if (picked.length >= WARM_THREADS) break;
    add(t);
  }
  // Low concurrency: each cold probe holds an Iroh dial for ~4s; don't stampede
  // the daemon. Warm threads short-circuit, so this rarely does real work.
  await mapLimit(picked.slice(0, WARM_THREADS), 2, async (t) => {
    try {
      await getMessages(t.agent, t.id);
    } catch {}
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
        if (cur === "completed" && prev === "running")
          note = { title: "✅ Task done", body: label };
        else if (cur === "failed") note = { title: "❌ Task failed", body: label };
        else if (cur === "awaiting_input") note = { title: "🔔 Waiting on you", body: label };
        if (!note) continue;
        for (const to of pushTokens) {
          messages.push({
            to,
            sound: "default",
            title: note.title,
            body: note.body,
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

/**
 * Largest JSON body we will hold in memory.
 *
 * Generous next to anything real — a turn's text, a CLAUDE.md being saved — and
 * the point is only that a ceiling EXISTS. /v1/access/request is deliberately
 * unauthenticated (a peer asking for access holds no credential yet) and calls
 * this before the token gate, so without a cap any host on the network could
 * hand the bridge an endless body and grow the process until it died.
 */
const MAX_BODY_BYTES = 10 * 1024 * 1024;

function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    let bytes = 0;
    let done = false;
    // An over-long body resolves EMPTY rather than rejecting: every route
    // already treats an unparseable body that way and answers with its own
    // "field required" 400, so the ceiling needs no new error path at ~30 call
    // sites. The socket is destroyed so the sender stops writing.
    req.on("data", (d) => {
      if (done) return;
      bytes += d.length;
      if (bytes > MAX_BODY_BYTES) {
        done = true;
        req.destroy();
        resolve({});
        return;
      }
      b += d;
    });
    req.on("aborted", () => {
      if (!done) ((done = true), resolve({}));
    });
    req.on("error", () => {
      if (!done) ((done = true), resolve({}));
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      try {
        resolve(JSON.parse(b || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

/** Below this, gzip's ~20-byte envelope and the CPU cost aren't worth it. */
const GZIP_MIN_BYTES = 1024;

/**
 * JSON response with conditional-GET validation and gzip.
 *
 * The etag is hashed from the bytes actually being sent, NOT from a version
 * counter over the session index: `getThreads` hands out object references that
 * `enrichThreadActivity` mutates in place afterwards, and `flagAwaitingPrompt`
 * folds in PTY prompt state that never touches disk. Neither shows up in an
 * fs.watch-derived counter, so a counter would serve 304s over exactly the
 * updates the app polls for. Hashing the payload is correct by construction.
 *
 * Order matters: hash first and return 304 BEFORE gzip runs, so an unchanged
 * poll — the common case at the app's ~10s sync — costs one sha1 instead of a
 * full compress plus transfer.
 *
 * Request details ride on `res.reqInfo`, stamped by the main handler, so the
 * ~40 existing call sites need no change.
 */
function send(res, code, body) {
  const json = JSON.stringify(body);
  const info = res.reqInfo || {};
  const headers = {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    vary: "accept-encoding",
  };

  // Validators only apply to a cacheable GET carrying a real body.
  if (info.method === "GET" && code === 200) {
    headers.etag = `W/"${createHash("sha1").update(json).digest("base64url").slice(0, 22)}"`;
    // "no-cache" = store it, but revalidate every time — never serve stale.
    // Required: the app calls bare `fetch` with no cache hints, so without an
    // explicit directive the platform HTTP caches (NSURLSession URLCache,
    // OkHttp) fall back to heuristic freshness and may never send
    // If-None-Match at all, leaving the 304 path dead.
    headers["cache-control"] = "no-cache";
    if (info.ifNoneMatch === headers.etag) {
      res.writeHead(304, headers);
      return res.end();
    }
  }

  const buf = Buffer.from(json);
  if (!info.gzip || buf.length < GZIP_MIN_BYTES) {
    res.writeHead(code, headers);
    return res.end(buf);
  }
  // Async gzip: a multi-MB thread list must not stall the event loop while turn
  // and thread SSE streams are live on other sockets. Fall back to identity if
  // compression fails — the body is still valid, just larger.
  gzip(buf, (err, out) => {
    if (res.writableEnded) return;
    if (err) {
      res.writeHead(code, headers);
      return res.end(buf);
    }
    res.writeHead(code, { ...headers, "content-encoding": "gzip" });
    res.end(out);
  });
}

let lastClientSeen = 0; // updated on every authed app request — a liveness signal
let PAIR = null; // { ip, port, pairUrl, deepLink } — set once we're listening

/** Whether the machine-wide tunnel identity belongs to THIS bridge. It always
 *  targets the default-port bridge (see ensureTunnel's singleton guard), so a
 *  dev bridge on another port must never advertise it — a phone dialing that
 *  node id would reach the default bridge, not this one. */
function tunnelEligible() {
  return PORT === DEFAULT_PORT || process.env.POUNCE_TUNNEL === "1";
}

/** The tunnel's Iroh identity, written to ~/.pounce/tunnel.json by
 *  `pounce-tunnel serve` at startup. The identity key (~/.pounce/tunnel.key)
 *  persists, so the nodeId is stable across restarts — a stale file from a
 *  previous run still names the right endpoint. Null until a tunnel has run. */
function tunnelInfo() {
  try {
    const info = JSON.parse(
      readFileSync(path.join(os.homedir(), ".pounce", "tunnel.json"), "utf8"),
    );
    return info?.nodeId ? { nodeId: info.nodeId, relay: info.relay || null } : null;
  } catch {
    return null;
  }
}

/** The pairing deep link, computed fresh so it picks up the tunnel identity
 *  whenever it's known: scanning it then works from any network, not just the
 *  LAN — the app saves the node/relay and dials over Iroh when the LAN URL is
 *  unreachable. */
function pairDeepLink() {
  if (!PAIR) return null;
  let link = `pounce://connect?url=${encodeURIComponent(PAIR.pairUrl)}&token=${encodeURIComponent(TOKEN)}`;
  const t = tunnelEligible() ? tunnelInfo() : null;
  if (t) {
    link += `&node=${encodeURIComponent(t.nodeId)}&host=${encodeURIComponent(os.hostname().replace(/\.local$/, ""))}`;
    if (t.relay) link += `&relay=${encodeURIComponent(t.relay)}`;
  }
  return link;
}

// --- peer access ---------------------------------------------------------------
// Other machines finding this one, asking it for a scoped read-only look at its
// threads, and losing that access when the grant lapses. See agents/access.mjs
// for the handshake and agents/discovery.mjs for the beacon.

const access = createAccess();
// One credential per paired device, so rotating the shared token — or an
// upgrade whose migration window elapsed — cannot drop a phone. See devices.mjs.
const devices = createDevices();

/**
 * One row per device for the "who can see this?" screen, out of the two places
 * a pairing can be recorded.
 *
 * A phone approved before this change has an access.mjs `device:` row and no
 * credential of its own; one approved after has both, keyed the same way (the
 * requester's bridgeId). Showing both would list it twice, and showing the old
 * row would offer a Remove that cannot work — only the credential can be
 * revoked. So the revocable row wins, and the legacy row survives only where
 * nothing has adopted yet, carrying `revocable: false` to say why its removal
 * still means re-pairing everything.
 */
function mergeDeviceRows(owned, legacy) {
  const byId = new Map(owned.map((d) => [d.id, { ...d, revocable: true }]));
  for (const d of legacy) {
    if (!byId.has(d.bridgeId)) {
      byId.set(d.bridgeId, {
        id: d.bridgeId,
        name: d.hostName,
        platform: d.platform,
        pairedAt: d.pairedAt,
        lastSeenAt: null,
        revocable: false,
      });
    }
  }
  return [...byId.values()];
}

/**
 * Announcing this machine to the network is OPT-IN. LOOKING is not.
 *
 * The beacon carries the machine's NAME, and a name is usually a person's. Any
 * default that switched it on would put that on every café, office and
 * co-working wifi the laptop ever joins, chosen by nobody — and once shipped it
 * cannot be un-shipped from installs already out there. So silence is the
 * default and the user turns it on, from /peers, the app, or the CLI.
 *
 * None of that argument applies to LISTENING, which discloses nothing, so the
 * beacon socket runs from boot regardless and only the announce half is gated
 * here. Seeing who is out there and asking one of them for access are the two
 * things a person on this screen came to do; requiring them to advertise
 * themselves first was a toll, not a safeguard.
 *
 * Precedence: POUNCE_DISCOVERY wins outright (scripted and fleet setups need to
 * be able to state it), then the persisted choice, then off.
 *
 * The port guard is separate and survives both: announcing is a claim to BE
 * this machine's bridge, and a dev bridge on 8100 must not invite peers to
 * knock on a door that closes when the dev server stops. It, too, is about
 * announcing only — a dev bridge can still show you the network.
 */
function discoveryWanted() {
  if (process.env.POUNCE_DISCOVERY === "0") return false;
  if (process.env.POUNCE_DISCOVERY === "1") return true;
  return readConfig().discoverable === true;
}
const discoveryEligible = () => PORT === DEFAULT_PORT || process.env.POUNCE_DISCOVERY === "1";

// Announcing is flipped on demand, so the toggle takes effect without
// restarting the bridge — a setting you have to reboot for is a setting people
// leave alone.
const discovery = createDiscovery({
  bridgeId: machineBridgeId(),
  port: PORT,
  version: () => APP_VERSION,
  announcing: discoveryEligible() && discoveryWanted(),
});

/** Bring the beacon in line with the current setting. Safe to call repeatedly:
 *  start() and setAnnouncing() are both no-ops when already in that state. */
function syncDiscovery() {
  discovery.start();
  return discovery.setAnnouncing(discoveryEligible() && discoveryWanted());
}

/** How the toggle is presented: whether it's on, whether this bridge is even
 *  allowed to announce, and whether an env var has taken the decision away.
 *  `on` is about being FOUND — the list beside it is populated either way. */
function discoveryState() {
  return {
    on: !!discovery.announcing,
    eligible: discoveryEligible(),
    // A dev bridge on a non-default port, or POUNCE_DISCOVERY set explicitly —
    // either way the UI should show the state, not a control that won't stick.
    locked: process.env.POUNCE_DISCOVERY === "0" || process.env.POUNCE_DISCOVERY === "1",
    chosen: readConfig().discoverable,
  };
}

/** Reap grants that have run out, and the guest tunnels holding their doors
 *  open. Belt and braces alongside the per-request expiry check: a grant nobody
 *  is using should still stop existing on time. */
function sweepAccess() {
  for (const g of access.sweep()) stopGrantTunnel(g.id);
}

/** The owner's own controls (approve, revoke, browse peers) are not something a
 *  guest may reach, and not something the LAN may reach either — only this
 *  machine's app, holding this machine's token. */
function isOwner(req) {
  return isLoopback(req) && !req.grant;
}

/** How a granted peer reaches this machine afterwards. The LAN address is what
 *  it used to ask; the tunnel identity is what keeps working once it leaves. */
function ownIdentity() {
  return {
    id: machineBridgeId(),
    hostName: os.hostname().replace(/\.local$/, ""),
    url: PAIR?.pairUrl ?? null,
    nodeId: null,
    relay: null,
  };
}

// --- asking ANOTHER machine for access -------------------------------------------
// The requester half, run by the bridge rather than by an app.
//
// It has to live here for two reasons. The desktop app is macOS-only, so on
// Windows and Linux the bridge IS the client. And even on a Mac, the bridge's
// own /peers page cannot call a peer directly: that is a cross-origin request,
// and every bridge refuses anything carrying an Origin it did not serve. So the
// page (and the CLI, and anything else local) asks us, and we do the talking.

/** A short, plain HTTP call to a peer. Never sends an Origin — we are not a
 *  browser — so the peer's own guard is satisfied. */
async function peerFetch(url, opts = {}, timeoutMs = 10_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      ...opts,
      signal: ctrl.signal,
      headers: { "content-type": "application/json", ...(opts.headers || {}) },
    });
    const body = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, body };
  } finally {
    clearTimeout(timer);
  }
}

/** How we introduce ourselves to a peer — the same identity our beacon carries,
 *  so the peer can match the request to the machine it can see on the network. */
function selfDescriptor() {
  return {
    bridgeId: machineBridgeId(),
    hostName: os.hostname().replace(/\.local$/, ""),
    platform: process.platform,
    appVersion: APP_VERSION,
  };
}

/** Pending requests waiting on a human, surfaced where a human will see them.
 *  The desktop app polls /v1/access; this is for when its window isn't open. */
function notifyAccessRequest(reqRow) {
  if (!reqRow) return;
  // A machine that already holds access is asking for MORE, and saying so is
  // the whole value of the line: "wants read access" from a name you granted
  // yesterday reads like a duplicate or a replay, and the safe-looking response
  // to that is to ignore it.
  const what = reqRow.existing
    ? `wants MORE than the ${reqRow.existing.summary} it already reads`
    : `wants ${reqRow.kind} access`;
  console.log(
    `[access] ${reqRow.requester.hostName} ${what} — code ${reqRow.code}. Approve in Pounce.`,
  );
}

/** A grant's scope resolved against the CURRENT thread list, so a thread started
 *  today in a space granted yesterday is included — the owner agreed to the
 *  space, not to a snapshot of what happened to be in it. */
async function grantScope(req) {
  return resolveScope(req.grant?.scope, await getThreads());
}

/**
 * Refuse a guest request that names something outside its scope, BEFORE the
 * route runs.
 *
 * Out-of-scope answers 404 and not 403 throughout: a guest must not be able to
 * map which threads exist on the machine by watching which ids give a different
 * error. "Not found" is also simply true from where it stands.
 */
async function guardScopedParams(req, url) {
  const scope = await grantScope(req);
  if (scope.full) return null;
  const p = url.pathname;
  const miss = { code: 404, body: { error: "not found" } };

  // Routes addressed by (agent, thread).
  if (["/v1/messages", "/v1/image", "/v1/trajectory", "/v1/usage"].includes(p)) {
    const agent = url.searchParams.get("agent");
    const thread = url.searchParams.get("thread");
    if (!agent || !thread) return null; // the route's own 400 is the better answer
    return scope.keys.has(`${agent}:${thread}`) ? null : miss;
  }
  // Markers can be asked for across every thread at once, which would enumerate
  // the lot. A guest must name a thread it holds.
  if (p === "/v1/markers") {
    const thread = url.searchParams.get("thread");
    return thread && scope.ids.has(thread) ? null : miss;
  }
  // Routes addressed by a directory: allowed only inside a granted thread's
  // checkout or worktree.
  if (["/v1/context", "/v1/git/changes", "/v1/git/checks"].includes(p)) {
    return pathInScope(scope, url.searchParams.get("cwd")) ? null : miss;
  }
  if (p === "/v1/file") {
    return pathInScope(scope, url.searchParams.get("path")) ? null : miss;
  }
  return null;
}

/** Narrow a thread list to what a grant may see. */
function filterThreads(scope, threads) {
  if (scope.full) return threads;
  return threads.filter((t) => scope.keys.has(`${t.agent}:${t.id}`));
}

/**
 * The catalog a PREVIEW grant reads: enough to choose what to ask for, and
 * nothing more.
 *
 * Projected by hand rather than by deleting fields from a thread, so a field
 * added to the thread shape later cannot leak here by default. Notably absent:
 * `preview` (the first user message), `cwd`, `gitBranch`, `modelProvider`.
 */
function catalogThread(t) {
  return {
    id: t.id,
    agent: t.agent,
    name: t.name,
    repoKey: t.repo,
    createdAt: t.createdAt,
    lastActivityAt: t.lastActivityAt || t.createdAt,
  };
}

function catalogSpaces(threads) {
  const byRepo = new Map();
  for (const t of threads) {
    // The repo key is already a real folder name (see resolveWorktreeOwners),
    // so there is nothing to translate — the app names spaces from this.
    const row = byRepo.get(t.repo) ?? {
      repoKey: t.repo,
      threadCount: 0,
      firstActivityAt: null,
      lastActivityAt: null,
    };
    row.threadCount++;
    const first = t.createdAt;
    const last = t.lastActivityAt || t.createdAt;
    if (first && (!row.firstActivityAt || first < row.firstActivityAt)) row.firstActivityAt = first;
    if (last && (!row.lastActivityAt || last > row.lastActivityAt)) row.lastActivityAt = last;
    byRepo.set(t.repo, row);
  }
  return [...byRepo.values()].sort((a, b) =>
    (b.lastActivityAt || "").localeCompare(a.lastActivityAt || ""),
  );
}

/** Only the machine running the bridge may read the UI surface (it leaks the token). */
function isLoopback(req) {
  const a = req.socket.remoteAddress || "";
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

/** Is this request from a page THIS bridge served? Loopback socket AND an Origin
 *  naming our own address and port — both, so neither can be claimed alone. */
function isOwnOrigin(req) {
  if (!isLoopback(req)) return false;
  const o = req.headers.origin;
  return o === `http://127.0.0.1:${PORT}` || o === `http://localhost:${PORT}`;
}

// The DNS-rebinding gate is hostIsAddress, imported from agents/host-guard.mjs
// — see that file for why the Origin check below does not cover it.

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
/* Quiet by default; turns into a call to action the moment a machine asks. */
.peerlink{font-size:12px;color:var(--muted);text-decoration:none;border-bottom:1px solid transparent}
.peerlink:hover{color:var(--accent);border-color:var(--accent)}
.peerlink.due{font-weight:700;color:var(--accent)}
</style></head>
<body><main class="card">
<header class="brand"><span class="paw">🐾</span><h1>Pounce&nbsp;Bridge</h1></header>
<p class="sub">Scan with your iPhone to connect</p>
<div class="qrwrap"><img id="qr" class="qr" alt="Pairing QR code"/></div>
<div class="addr" id="addr">—</div>
<div class="status"><span class="dot idle" id="dot"></span><span id="statusText">Starting…</span></div>
<div class="syncbar" id="syncbar"><i></i></div>
<p class="hint" id="hint">Open Pounce on your phone, go to Sync, and scan this code.</p>
<a class="peerlink" id="peerlink" href="/peers">Share with another computer &rarr;</a>
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
    // A machine asking for access must be visible from the page people
    // actually leave open, not only from /peers.
    if(d.token) fetch('/v1/access',{cache:'no-store',headers:{authorization:'Bearer '+d.token}})
      .then(function(r){return r.json();}).then(function(a){
        var n = (a.pending||[]).length, el = document.getElementById('peerlink');
        el.textContent = n ? (n===1?'1 machine is asking for access →':n+' machines are asking for access →')
                           : 'Share with another computer →';
        el.className = n ? 'peerlink due' : 'peerlink';
      }).catch(function(){});
  }).catch(function(){ set('statusText','Starting...'); });
}
tick(); setInterval(tick, 1200);
</script></body></html>`;

/**
 * The bridge’s own peer-sharing page, at GET /peers (loopback only).
 *
 * This exists because the desktop app is macOS-only. On Windows and Linux — and
 * on any headless box someone has SSH’d into — the bridge IS the product, so the
 * whole handshake has to work from a browser pointed at localhost: find machines,
 * ask one for access, answer the ones asking you, and take access away again.
 *
 * Every peer call goes through /v1/peers/* rather than straight at the peer. This
 * page’s fetches would be cross-origin, and a bridge refuses anything carrying an
 * Origin it did not serve — so the bridge does the talking on the page’s behalf.
 *
 * Same dependency-free rules as UI_HTML: inline CSS, vanilla JS, no backticks.
 */
const PEERS_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Pounce · Machines</title>
<style>
:root{--bg:#faf7fb;--fg:#1a1320;--muted:#6b6472;--faint:#9a93a1;--accent:#7c3aed;--ok:#16a34a;--border:#ece7f0;--card:#fff}
@media(prefers-color-scheme:dark){:root{--bg:#141118;--fg:#f3f0f5;--muted:#a79fb0;--faint:#7c7486;--border:#2a2431;--card:#1c1822}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:640px;margin:0 auto;padding:24px 20px 60px}
h1{font-size:19px;margin:2px 0;letter-spacing:-.02em}
.lede{margin:0 0 6px;font-size:13px;color:var(--muted)}
h2{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--faint);margin:24px 0 8px}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:13px 15px;margin-bottom:8px}
.row{display:flex;align-items:center;gap:12px}
.grow{flex:1;min-width:0}
.name{font-size:14px;font-weight:600}
.meta{font-size:11.5px;color:var(--faint)}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
button{font:inherit;font-size:13px;font-weight:600;border-radius:9px;padding:7px 13px;border:1px solid var(--border);background:transparent;color:var(--muted);cursor:pointer}
button:hover{border-color:var(--faint)}
button.p{background:var(--accent);border-color:var(--accent);color:#fff}
button:disabled{opacity:.45;cursor:default}
.code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:17px;letter-spacing:2px;color:var(--muted)}
.empty{font-size:13px;color:var(--muted);line-height:1.55;margin:6px 0 0}
.note{font-size:12px;font-style:italic;color:var(--muted);margin:6px 0 0}
.field{font-size:11px;font-weight:700;color:var(--faint);margin:12px 0 5px;text-transform:uppercase;letter-spacing:.05em}
label.opt{display:flex;align-items:center;gap:8px;font-size:13px;padding:3px 0;cursor:pointer}
.box{border:1px solid var(--border);border-radius:9px;max-height:190px;overflow-y:auto;padding:8px;margin-top:6px}
.box label{display:flex;align-items:center;gap:8px;font-size:12.5px;padding:3px 2px;cursor:pointer}
.box .sp{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.glabel{font-size:10px;font-weight:700;color:var(--faint);text-transform:uppercase;margin:8px 0 2px}
input[type=search]{width:100%;font:inherit;font-size:13px;padding:7px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--fg);margin-top:8px}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{border-radius:999px;padding:5px 11px;font-size:12px}
.chip.on{background:var(--accent);border-color:var(--accent);color:#fff}
.actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:14px}
.spin{display:inline-block;width:13px;height:13px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:sp .8s linear infinite;vertical-align:-2px;margin-right:7px}
@keyframes sp{to{transform:rotate(360deg)}}
a.back{font-size:12px;color:var(--accent);text-decoration:none}
</style></head>
<body><div class="wrap">
<a class="back" href="/">&larr; Pairing</a>
<h1>Machines</h1>
<p class="lede">Share this machine's threads with another computer, or ask one to share with you. Access is read-only and expires.</p>
<div id="app"></div>
</div>
<script>
var TOKEN = null, state = {peers:[], pending:[], grants:[], held:[], spaces:[], discovery:{}}, flow = null, busy = false;

function h(tag, attrs, kids){
  var e = document.createElement(tag);
  attrs = attrs || {};
  for(var k in attrs){
    if(k === 'text') e.textContent = attrs[k];
    else if(k.slice(0,2) === 'on') e[k] = attrs[k];
    else if(attrs[k] !== null && attrs[k] !== undefined) e.setAttribute(k, attrs[k]);
  }
  (kids||[]).forEach(function(c){ if(c) e.appendChild(c); });
  return e;
}
function api(path, opts){
  opts = opts || {};
  opts.headers = Object.assign({'content-type':'application/json'}, opts.headers||{}, {authorization:'Bearer '+TOKEN});
  return fetch(path, opts).then(function(r){ return r.json().catch(function(){ return {}; }); });
}
function left(iso){
  if(!iso) return 'no expiry';
  var d = Math.round((Date.parse(iso) - Date.now())/60000);
  if(d <= 0) return 'expired';
  if(d < 1) return 'under a minute';
  if(d < 60) return d + 'm left';
  if(d < 2880) return Math.round(d/60) + 'h left';
  return Math.round(d/1440) + 'd left';
}
function day(iso){
  if(!iso) return '?';
  var n = Math.floor((Date.now() - Date.parse(iso))/86400000);
  if(n <= 0) return 'today';
  if(n === 1) return 'yesterday';
  return new Date(iso).toLocaleDateString(undefined,{month:'short',day:'numeric'});
}
function span(a,b){ var x = day(a), y = day(b); return x === y ? x : x + ' → ' + y; }
function fmtCode(c){ return c ? c.slice(0,3) + '-' + c.slice(3) : ''; }
function summarize(sc){
  if(!sc || sc.kind === 'full') return 'Everything';
  var bits = [];
  if(sc.repoKeys && sc.repoKeys.length) bits.push(sc.repoKeys.length === 1 ? sc.repoKeys[0] : sc.repoKeys.length + ' spaces');
  if(sc.threads && sc.threads.length) bits.push(sc.threads.length + ' thread' + (sc.threads.length === 1 ? '' : 's'));
  return bits.join(' + ') || 'Nothing';
}

function refresh(){
  if(flow) return Promise.resolve();
  return Promise.all([api('/v1/peers'), api('/v1/access'), api('/v1/peers/granted')]).then(function(r){
    state.peers = r[0].peers || [];
    state.discovery = r[0].discovery || {};
    state.pending = r[1].pending || [];
    state.grants = r[1].grants || [];
    state.held = r[2].held || [];
    render();
  });
}

function startAsk(peer){
  flow = {peer:peer, step:'waiting', what:'a look at what is there'};
  render();
  api('/v1/peers/ask', {method:'POST', body:JSON.stringify({peerUrl:peer.url, kind:'preview'})}).then(function(a){
    if(a.error || !a.requestId){ flow = {peer:peer, step:'failed', why:a.error || 'Could not reach that machine.'}; return render(); }
    flow.code = a.code; flow.askId = a.requestId; render(); pollAsk();
  });
}
function pollAsk(){
  if(!flow || flow.step !== 'waiting') return;
  var id = flow.askId;
  api('/v1/peers/ask/' + id).then(function(r){
    if(!flow || flow.askId !== id) return;
    if(r.state === 'approved' && r.token && r.kind === 'preview'){
      flow = {peer:flow.peer, step:'catalog', token:r.token, grantId:r.grantId, spaces:[], hits:[], picked:{}, threads:{}, q:''};
      render(); loadCatalog(); return;
    }
    if(r.state === 'approved'){
      flow = {peer:flow.peer, step:'done', scope:r.scope, expiresAt:r.expiresAt};
      render(); setTimeout(function(){ flow = null; refresh(); }, 6000); return;
    }
    if(r.state && r.state !== 'pending'){
      flow = {peer:flow.peer, step:'failed', why:'They did not grant access (' + r.state + ').'};
      return render();
    }
    setTimeout(pollAsk, 2000);
  });
}
function loadCatalog(){
  var f = flow;
  api('/v1/peers/catalog?peer=' + encodeURIComponent(f.peer.url) + '&token=' + encodeURIComponent(f.token))
    .then(function(r){ if(flow === f){ f.spaces = r.spaces || []; render(); } });
}
function searchCatalog(q){
  var f = flow;
  f.q = q;
  if(f.timer) clearTimeout(f.timer);
  if(!q.trim()){ f.hits = []; return render(); }
  f.timer = setTimeout(function(){
    api('/v1/peers/catalog?peer=' + encodeURIComponent(f.peer.url) + '&token=' + encodeURIComponent(f.token) + '&q=' + encodeURIComponent(q))
      .then(function(r){ if(flow === f){ f.hits = r.threads || []; render(); } });
  }, 250);
}
function askRead(){
  var f = flow;
  var repoKeys = Object.keys(f.picked).filter(function(k){ return f.picked[k]; });
  var threads = Object.keys(f.threads).filter(function(k){ return f.threads[k]; }).map(function(k){ return f.threads[k]; });
  flow = {peer:f.peer, step:'waiting', what:'read access'};
  render();
  api('/v1/peers/ask', {method:'POST', body:JSON.stringify({peerUrl:f.peer.url, kind:'read', previewGrant:f.grantId, scope:{repoKeys:repoKeys, threads:threads}})})
    .then(function(a){
      if(a.error || !a.requestId){ flow = {peer:f.peer, step:'failed', why:a.error || 'Could not reach that machine.'}; return render(); }
      flow.code = a.code; flow.askId = a.requestId; render(); pollAsk();
    });
}

function act(path, body){
  if(busy) return;
  busy = true;
  api(path, {method:'POST', body:JSON.stringify(body)}).then(function(){ busy = false; refresh(); });
}

function render(){
  var app = document.getElementById('app');
  app.innerHTML = '';
  if(flow){ app.appendChild(renderFlow()); return; }

  if(state.pending.length){
    app.appendChild(h('h2',{text:'Waiting on you'}));
    state.pending.forEach(function(r){ app.appendChild(renderRequest(r)); });
  }

  // This machine first, then who else is out there — and the peer list is shown
  // whether or not this one is visible, since looking and being looked at are
  // separate settings now.
  app.appendChild(h('h2',{text:'Connect'}));
  app.appendChild(renderDiscoveryToggle());
  app.appendChild(h('h2',{text:'Machines on this network'}));
  if(!state.peers.length){
    app.appendChild(h('p',{class:'empty',text:'No machines on this network yet. The other computer needs Pounce running and set to discoverable, on the same network as this one.'}));
  } else {
    state.peers.forEach(function(p){
      app.appendChild(h('div',{class:'card'},[h('div',{class:'row'},[
        h('div',{class:'grow'},[h('div',{class:'name',text:p.hostName}), h('div',{class:'meta mono',text:p.address + ':' + p.port})]),
        h('button',{class:'p', onclick:function(){ startAsk(p); }, text:'Ask for access'})
      ])]));
    });
  }

  app.appendChild(h('h2',{text:'Access you hold'}));
  if(!state.held.length){
    app.appendChild(h('p',{class:'empty',text:'None yet. Ask a machine above, and its owner decides what you can read.'}));
  } else {
    state.held.forEach(function(g){
      app.appendChild(h('div',{class:'card'},[h('div',{class:'row'},[
        h('div',{class:'grow'},[
          h('div',{class:'name',text:g.hostName || g.url}),
          h('div',{class:'meta',text:summarize(g.scope) + ' · ' + left(g.expiresAt)})
        ]),
        h('button',{onclick:function(){
          if(busy) return;
          busy = true;
          api('/v1/peers/granted/' + encodeURIComponent(g.id), {method:'DELETE'}).then(function(){ busy = false; refresh(); });
        }, text:'Forget'})
      ])]));
    });
  }

  app.appendChild(h('h2',{text: state.grants.length ? 'Machines with access to this one' : 'Nobody has access to this one'}));
  if(!state.grants.length){
    app.appendChild(h('p',{class:'empty',text:'When another computer asks to read this machine’s threads, the request appears at the top of this page.'}));
  } else {
    state.grants.forEach(function(g){
      app.appendChild(h('div',{class:'card'},[h('div',{class:'row'},[
        h('div',{class:'grow'},[
          h('div',{class:'name',text:g.requester.hostName}),
          h('div',{class:'meta',text:(g.kind === 'preview' ? 'Browsing names' : g.summary) + ' · ' + left(g.expiresAt) + (g.lastUsedAt ? '' : ' · not used yet')})
        ]),
        h('button',{onclick:function(){ act('/v1/access/revoke',{grantId:g.id}); }, text:'Revoke'})
      ])]));
    });
  }
}

function renderDiscoveryToggle(){
  var d = state.discovery || {};
  var card = h('div',{class:'card'});
  var row = h('div',{class:'row'});
  row.appendChild(h('div',{class:'grow'},[
    h('div',{class:'name',text: d.on ? 'Discoverable' : 'Not discoverable'}),
    h('div',{class:'meta',text: d.on
      ? 'They see its name, and can ask to read the projects you choose.'
      : 'You can still see the machines below and ask them for access. This only decides whether this one appears in their list.'})
  ]));
  if(!d.eligible){
    row.appendChild(h('div',{class:'meta',text:'not available here'}));
  } else if(d.locked){
    row.appendChild(h('div',{class:'meta',text:'set on this machine'}));
  } else {
    row.appendChild(h('button',{class: d.on ? '' : 'p', onclick:function(){
      if(busy) return;
      busy = true;
      api('/v1/peers/discovery',{method:'POST',body:JSON.stringify({enabled:!d.on})})
        .then(function(){ busy = false; refresh(); });
    }, text: d.on ? 'Turn off' : 'Make discoverable'}));
  }
  card.appendChild(row);
  return card;
}

function renderRequest(r){
  var isPreview = r.kind === 'preview';
  // A phone asking to pair. Full access, like the QR — so it gets a plain
  // sentence and no scope picker rather than controls that would imply the
  // access can be narrowed.
  var isDevice = r.kind === 'device';
  var sel = {everything: !r.scope || r.scope.kind === 'full', picked:{}, hours:24, q:'', hits:[], timer:null};
  if(r.scope && r.scope.repoKeys) r.scope.repoKeys.forEach(function(k){ sel.picked[k] = true; });
  var loose = (r.scope && r.scope.threads) ? r.scope.threads.slice() : [];
  var card = h('div',{class:'card'});

  function scopeNow(){
    if(sel.everything) return {kind:'full'};
    return {repoKeys:Object.keys(sel.picked).filter(function(k){ return sel.picked[k]; }), threads:loose};
  }
  function draw(){
    card.innerHTML = '';
    card.appendChild(h('div',{class:'row'},[
      h('div',{class:'grow'},[
        h('div',{class:'name',text:r.requester.hostName + ' wants ' + (isDevice ? 'to pair with this Mac' : isPreview ? 'a look at what is here' : 'read access')}),
        h('div',{class:'meta',text:isDevice ? 'Full access to your agents, the same as scanning the pairing code. Remove it later from Settings on that device.' : isPreview ? 'Space and thread names only — no messages, for a few minutes.' : 'Asked for: ' + summarize(r.scope)})
      ]),
      h('div',{class:'code',text:fmtCode(r.code)})
    ]));
    if(r.note) card.appendChild(h('p',{class:'note',text:'“' + r.note + '”'}));

    if(!isPreview && !isDevice){
      card.appendChild(h('div',{class:'field',text:'They can read'}));
      [['Everything on this machine', true], ['Only what I pick', false]].forEach(function(o){
        var input = h('input',{type:'radio',name:'sc' + r.id});
        input.checked = (sel.everything === o[1]);
        input.onchange = function(){ sel.everything = o[1]; draw(); };
        card.appendChild(h('label',{class:'opt'},[input, h('span',{text:o[0]})]));
      });
      if(!sel.everything){
        var search = h('input',{type:'search',placeholder:'Filter spaces, or search thread names…',value:sel.q});
        search.oninput = function(){
          sel.q = search.value;
          if(sel.timer) clearTimeout(sel.timer);
          if(!sel.q.trim()){ sel.hits = []; return draw(); }
          sel.timer = setTimeout(function(){
            api('/v1/catalog/threads?q=' + encodeURIComponent(sel.q)).then(function(x){ sel.hits = x.threads || []; draw(); });
          }, 250);
        };
        card.appendChild(search);
        var box = h('div',{class:'box'});
        var ql = sel.q.trim().toLowerCase();
        var shown = ql ? state.spaces.filter(function(s){ return s.repoKey.toLowerCase().indexOf(ql) >= 0; }) : state.spaces;
        shown.forEach(function(sp){
          var cb = h('input',{type:'checkbox'});
          cb.checked = !!sel.picked[sp.repoKey];
          cb.onchange = function(){ sel.picked[sp.repoKey] = cb.checked; draw(); };
          box.appendChild(h('label',{},[cb, h('span',{class:'sp',text:sp.repoKey}), h('span',{class:'meta',text:String(sp.threadCount)})]));
        });
        if(sel.hits.length) box.appendChild(h('div',{class:'glabel',text:'Threads'}));
        sel.hits.forEach(function(t){
          var cb = h('input',{type:'checkbox'});
          cb.checked = loose.some(function(x){ return x.id === t.id; });
          cb.onchange = function(){
            if(cb.checked) loose.push({agent:t.agent, id:t.id});
            else loose = loose.filter(function(x){ return x.id !== t.id; });
            draw();
          };
          box.appendChild(h('label',{},[cb, h('span',{class:'sp',text:t.name || 'Untitled thread'}), h('span',{class:'meta',text:t.repoKey})]));
        });
        if(ql && !shown.length && !sel.hits.length) box.appendChild(h('div',{class:'meta',text:'Nothing matches.'}));
        card.appendChild(box);
        if(loose.length) card.appendChild(h('div',{class:'meta',text:loose.length + ' single thread' + (loose.length === 1 ? '' : 's') + ' selected'}));
      }
      card.appendChild(h('div',{class:'field',text:'Until'}));
      var chips = h('div',{class:'chips'});
      [['1 hour',1],['8 hours',8],['1 day',24],['7 days',168],['No expiry',null]].forEach(function(d){
        chips.appendChild(h('button',{class:'chip' + (sel.hours === d[1] ? ' on' : ''), onclick:function(){ sel.hours = d[1]; draw(); }, text:d[0]}));
      });
      card.appendChild(chips);
    }

    var sc = scopeNow();
    var approve = h('button',{class:'p', onclick:function(){
      act('/v1/access/approve',{
        requestId:r.id,
        scope: (isPreview || isDevice) ? undefined : sc,
        expiresAt: (isPreview || isDevice || sel.hours === null) ? null : new Date(Date.now() + sel.hours*3600000).toISOString()
      });
    }, text: isDevice ? 'Pair this device' : isPreview ? 'Let them look' : 'Approve · ' + summarize(sc)});
    if(!isPreview && !isDevice && !sel.everything && !sc.repoKeys.length && !loose.length) approve.disabled = true;
    card.appendChild(h('div',{class:'actions'},[
      h('button',{onclick:function(){ act('/v1/access/deny',{requestId:r.id}); }, text:'Deny'}),
      approve
    ]));
  }
  draw();
  return card;
}

function renderFlow(){
  var f = flow;
  var card = h('div',{class:'card'});
  var cancel = h('button',{onclick:function(){ flow = null; refresh(); }, text:'Start over'});

  if(f.step === 'waiting'){
    card.appendChild(h('div',{class:'name'},[h('span',{class:'spin'}), h('span',{text:'Waiting for ' + f.peer.hostName})]));
    card.appendChild(h('p',{class:'empty',text:'Asking for ' + f.what + '. Approve it on that machine.'}));
    if(f.code){
      card.appendChild(h('div',{class:'field',text:'Check this code matches'}));
      card.appendChild(h('div',{class:'code',text:fmtCode(f.code)}));
    }
    card.appendChild(h('div',{class:'actions'},[cancel]));
    return card;
  }
  if(f.step === 'catalog'){
    card.appendChild(h('div',{class:'name',text:f.peer.hostName + ' is showing names and dates only'}));
    card.appendChild(h('p',{class:'empty',text:'Pick what you want to read.'}));
    var search = h('input',{type:'search',placeholder:'Filter spaces, or search thread names…',value:f.q});
    search.oninput = function(){ searchCatalog(search.value); };
    card.appendChild(search);
    var box = h('div',{class:'box'});
    var ql = (f.q || '').trim().toLowerCase();
    var shown = ql ? f.spaces.filter(function(s){ return s.repoKey.toLowerCase().indexOf(ql) >= 0; }) : f.spaces;
    shown.forEach(function(sp){
      var cb = h('input',{type:'checkbox'});
      cb.checked = !!f.picked[sp.repoKey];
      cb.onchange = function(){ f.picked[sp.repoKey] = cb.checked; render(); };
      box.appendChild(h('label',{},[cb,
        h('span',{class:'sp',text:sp.repoKey}),
        h('span',{class:'meta',text:sp.threadCount + ' · ' + span(sp.firstActivityAt, sp.lastActivityAt)})]));
    });
    if(f.hits.length) box.appendChild(h('div',{class:'glabel',text:'Threads'}));
    f.hits.forEach(function(t){
      var cb = h('input',{type:'checkbox'});
      cb.checked = !!f.threads[t.id];
      cb.onchange = function(){ f.threads[t.id] = cb.checked ? {agent:t.agent, id:t.id} : null; render(); };
      box.appendChild(h('label',{},[cb,
        h('span',{class:'sp',text:t.name || 'Untitled thread'}),
        h('span',{class:'meta',text:t.repoKey + ' · ' + span(t.createdAt, t.lastActivityAt)})]));
    });
    if(ql && !shown.length && !f.hits.length) box.appendChild(h('div',{class:'meta',text:'Nothing matches.'}));
    card.appendChild(box);
    var n = Object.keys(f.picked).filter(function(k){ return f.picked[k]; }).length
          + Object.keys(f.threads).filter(function(k){ return f.threads[k]; }).length;
    var go = h('button',{class:'p', onclick:askRead, text:'Request read access'});
    if(!n) go.disabled = true;
    card.appendChild(h('div',{class:'actions'},[
      h('div',{class:'grow meta',text: n ? n + ' selected' : 'Nothing selected yet'}), cancel, go
    ]));
    return card;
  }
  if(f.step === 'done'){
    card.appendChild(h('div',{class:'name',text:'Connected to ' + f.peer.hostName}));
    card.appendChild(h('p',{class:'empty',text:'You can read ' + summarize(f.scope) + ' · ' + left(f.expiresAt) + '. It is listed under “Access you hold”.'}));
    return card;
  }
  card.appendChild(h('div',{class:'name',text:f.peer.hostName + ' did not grant access'}));
  card.appendChild(h('p',{class:'empty',text:f.why || ''}));
  card.appendChild(h('div',{class:'actions'},[cancel]));
  return card;
}

fetch('/ui',{cache:'no-store'}).then(function(r){ return r.json(); }).then(function(d){
  TOKEN = d.token;
  return api('/v1/catalog/spaces');
}).then(function(r){
  state.spaces = r.spaces || [];
  refresh();
  setInterval(refresh, 3000);
});
</script></body></html>
`;

const server = http.createServer(async (req, res) => {
  // Everything send() needs from the request, captured once so the response
  // helper stays a (res, code, body) call at ~40 sites.
  res.reqInfo = {
    method: req.method,
    gzip: /\bgzip\b/.test(req.headers["accept-encoding"] || ""),
    ifNoneMatch: req.headers["if-none-match"] || null,
  };
  const url = new URL(req.url, "http://x");

  // No route here is meant to be called from a web page. The apps are native and
  // the DOM screens fetch same-origin, so an Origin header is always someone
  // else's page — and every JSON reply carries `access-control-allow-origin: *`,
  // which would otherwise let a site the user merely VISITS read /ui (the token
  // is in that payload) or POST to /v1/exec without a preflight. Rejecting on
  // sight also closes DNS rebinding, which loopback checks alone do not.
  // ...with ONE exception: the bridge's own loopback page. Browsers attach an
  // Origin to same-origin POSTs, so the approve/deny buttons on /peers would
  // otherwise 403 themselves. Matching our own origin exactly keeps every
  // property above: a rogue site sends its own origin, and non-loopback callers
  // are refused regardless of what they claim.
  //
  // DNS rebinding is NOT closed here — a rebound page is same-origin and sends
  // no Origin at all, so this check never fires for it. hostIsAddress is what
  // catches that, and it has to run first: every route below is behind it,
  // including the unauthenticated ones and /ui, which carries the token.
  if (!hostIsAddress(req.headers.host)) return send(res, 403, { error: "forbidden" });
  if (req.headers.origin && !isOwnOrigin(req)) return send(res, 403, { error: "forbidden" });

  if (url.pathname === "/health") return send(res, 200, { ok: true });

  /**
   * "Who are you?" — for a phone sweeping the local subnet.
   *
   * Deliberately unauthenticated and LAN-reachable, carrying exactly what the
   * discovery beacon already broadcasts to the whole network (agents/discovery.mjs):
   * a name, a platform, a stable id. No token, no repo names, no thread titles.
   * A phone can't join the beacon's multicast group without an entitlement Apple
   * grants case by case, so it probes for this instead — same information, same
   * exposure, reachable over plain HTTP.
   *
   * `bridgeId` is the machine id devices canonicalize on, so a machine found
   * here and one paired by QR collapse onto a single row.
   */
  if (url.pathname === "/v1/hello") {
    return send(res, 200, {
      ok: true,
      bridgeId: machineBridgeId(),
      hostName: os.hostname().replace(/\.local$/, ""),
      platform: process.platform,
      port: PORT,
      appVersion: APP_VERSION,
    });
  }

  // Localhost-only UI surface for the desktop app: pairing QR + live status.
  // Gated to loopback because it exposes the pairing token.
  if (
    url.pathname === "/" ||
    url.pathname === "/ui" ||
    url.pathname === "/qr.svg" ||
    url.pathname === "/peers"
  ) {
    if (!isLoopback(req)) return send(res, 403, { error: "local only" });
    if (url.pathname === "/peers") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      return res.end(PEERS_HTML);
    }
    if (url.pathname === "/") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      return res.end(UI_HTML);
    }
    if (url.pathname === "/qr.svg") {
      const link = pairDeepLink();
      const svg = link
        ? await QRCode.toString(link, { type: "svg", margin: 1 })
        : "<svg xmlns='http://www.w3.org/2000/svg'/>";
      res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "no-store" });
      return res.end(svg);
    }
    const daemon = await status().catch(() => null);
    return send(res, 200, {
      ...(PAIR || {}),
      deepLink: pairDeepLink(),
      tunnel: tunnelEligible() ? tunnelInfo() : null,
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

  // A peer asking for access holds no credential yet — that is the whole point,
  // and it is safe because the request is inert until a human on this machine
  // approves it. Sits above the auth gate for that reason, and nowhere else does.
  if (url.pathname === "/v1/access/request" && req.method === "POST") {
    const body = await readBody(req).catch(() => null);
    if (!body) return send(res, 400, { error: "bad request" });
    const r = access.submit({
      kind: body.kind,
      requester: body.requester,
      scope: body.scope,
      note: body.note,
      previewGrant: body.previewGrant,
      requestedHours: body.requestedHours,
      ip: req.socket.remoteAddress || "unknown",
    });
    if (!r.ok) return send(res, r.retryAfterMs ? 429 : 400, r);
    // Tell whoever is at the keyboard, even if the app window is behind
    // something. Nothing happens until they act on it.
    notifyAccessRequest(access.listPending().find((p) => p.id === r.requestId));
    return send(res, 200, r);
  }
  // The requester's poll for "have they said yes yet". Authenticated by the
  // claim secret it was handed at request time, not by a bridge token.
  if (url.pathname.startsWith("/v1/access/request/") && req.method === "GET") {
    const id = url.pathname.slice("/v1/access/request/".length);
    const r = access.poll(id, url.searchParams.get("claim"));
    if (!r.ok) return send(res, 404, r);
    // A grant that has just been approved needs somewhere to be reached: the
    // LAN address it already knows, plus the tunnel identity for when it isn't
    // on this network any more.
    // Own identity first, then whatever the approval attached — the per-grant
    // tunnel must win over the machine-wide one, which a guest can't dial.
    if (r.state === "approved" && r.token) r.bridge = { ...ownIdentity(), ...r.bridge };
    return send(res, 200, r);
  }

  const auth =
    req.headers.authorization?.replace(/^Bearer\s+/i, "") || url.searchParams.get("token");
  const legacyOk =
    Date.now() < LEGACY_UNTIL &&
    tokenMatches(auth, LEGACY_TOKEN) &&
    legacyAllows(req.method, url.pathname);
  // A device that has adopted its own credential (see agents/devices.mjs) is
  // the SAME authority as the shared token — it is the phone you paired, not a
  // guest — but it survives that token being rotated, which is the whole reason
  // it exists. Checked before grants because it is the common case.
  const device = tokenMatches(auth, TOKEN) || legacyOk ? null : devices.forToken(auth);
  if (!tokenMatches(auth, TOKEN) && !legacyOk && !device) {
    // Not the owner's token and not a device's. It may still be a grant issued
    // to a peer — read-only, narrowed to a scope, stamped with an expiry.
    const hit = access.forToken(auth);
    if (!hit) return send(res, 401, { error: "unauthorized" });
    if (hit.ended) {
      stopGrantTunnel(hit.grant.id);
      // Named distinctly from a plain 401 so the guest can drop the device and
      // its rows outright, instead of showing the machine as merely offline.
      return send(res, 401, { error: hit.reason, expiresAt: hit.grant.expiresAt });
    }
    if (!grantAllowsRoute(hit.grant, req.method, url.pathname)) {
      return send(res, 403, { error: "forbidden_for_grant" });
    }
    req.grant = hit.grant;
    access.touch(hit.grant.id);
    // Deliberately NOT counted as `lastClientSeen`: that drives "your phone is
    // connected" in the pairing window, and a peer reading history is not that.
  } else {
    lastClientSeen = Date.now();
    if (device) devices.touch(device.id);
  }

  // The migration itself: a client still holding the published default swaps it
  // for this install's real token, so the window closes on its next sync.
  if (url.pathname === "/v1/token") return send(res, 200, { token: TOKEN });

  /**
   * Take out a credential of this device's own, so an update can never drop it.
   *
   * Callable with the shared token (what the QR hands out) or with a device
   * token already held — i.e. by something that ALREADY has this authority, so
   * it grants nothing new. What it changes is durability: from here on the
   * caller stops depending on a value the bridge may rotate out from under it.
   *
   * Deliberately NOT reachable with the legacy constant (see LEGACY_DENY): that
   * password is in the git history, and letting it mint a credential which
   * never expires would be strictly worse than the 24h window it arrives with.
   * A grant can't reach it either — grantAllowsRoute refuses every non-GET.
   */
  if (url.pathname === "/v1/device/adopt" && req.method === "POST") {
    const { key, name, platform } = await readBody(req);
    const minted = devices.mint({ key, name, platform });
    // If the caller was ALREADY a device, that older row is now nobody's — it
    // authenticated this call and is being replaced by what we just minted.
    // Leaving it would strand a working credential the owner cannot attribute
    // to any phone. Only when the id actually changed: adopting under the same
    // key replaces the row in place, and revoking then would delete the new one.
    // (The two paths key differently — the app by its own row id, an approved
    // peer by bridgeId — so a phone that did both would otherwise orphan one.)
    if (device && device.id !== minted.id) devices.revoke(device.id);
    return send(res, 200, { deviceId: minted.id, token: minted.token });
  }
  if (process.env.BRIDGE_DEBUG) console.log(`[req] ${req.method} ${url.pathname}${url.search}`);

  // Everything below is inside the grant's scope or not served at all. Done
  // here rather than route by route so a route added later cannot forget it.
  if (req.grant) {
    const denial = await guardScopedParams(req, url).catch(() => ({
      code: 503,
      body: { error: "scope unavailable" },
    }));
    if (denial) return send(res, denial.code, denial.body);
  }

  try {
    // --- the owner's peer controls ---------------------------------------------
    // Not reachable with a grant (the allowlist stops that) and not from the LAN
    // either: approving access is a decision made at this keyboard.
    if (url.pathname === "/v1/peers") {
      if (!isOwner(req)) return send(res, 403, { error: "local only" });
      // Listening runs from boot, so the list is real whether or not this
      // machine announces itself. It used to be gated on `running`, which is
      // how being invisible turned into being blind.
      if (discovery.running) discovery.refresh();
      return send(res, 200, {
        peers: discovery.list(),
        discovery: discoveryState(),
        // Kept for older clients that read this boolean. They take it to mean
        // "am I visible", which is what it always described.
        discovering: !!discovery.announcing,
      });
    }
    // The toggle itself. Persisted, so it survives a restart, and applied
    // immediately so nobody has to relaunch the bridge to be found.
    if (url.pathname === "/v1/peers/discovery" && req.method === "POST") {
      if (!isOwner(req)) return send(res, 403, { error: "local only" });
      const { enabled } = await readBody(req);
      if (typeof enabled !== "boolean")
        return send(res, 400, { error: "enabled must be a boolean" });
      // Saying yes on a bridge that may not announce at all would persist a
      // setting that quietly does nothing, and report "hidden" right after the
      // user asked to be visible. Refuse with the reason instead.
      if (!discoveryState().eligible) {
        return send(res, 409, {
          error: "this bridge can't be made visible — it isn't the machine's main bridge",
          discovery: discoveryState(),
        });
      }
      if (discoveryState().locked) {
        return send(res, 409, {
          error:
            "POUNCE_DISCOVERY is set in this bridge's environment — unset it to use this toggle",
          discovery: discoveryState(),
        });
      }
      writeConfig({ discoverable: enabled });
      syncDiscovery();
      return send(res, 200, { ok: true, discovery: discoveryState() });
    }
    // Send an ask to a peer and remember the claim it hands back.
    if (url.pathname === "/v1/peers/ask" && req.method === "POST") {
      if (!isOwner(req)) return send(res, 403, { error: "local only" });
      const { peerUrl, kind, scope, previewGrant, note } = await readBody(req);
      if (!peerUrl || !kind) return send(res, 400, { error: "peerUrl and kind required" });
      const r = await peerFetch(`${peerUrl}/v1/access/request`, {
        method: "POST",
        body: JSON.stringify({ kind, requester: selfDescriptor(), scope, previewGrant, note }),
      }).catch((e) => ({ ok: false, status: 0, body: { error: String(e?.message || e) } }));
      if (!r.ok) return send(res, r.status || 502, r.body);
      access.rememberAsk(peerUrl, { ...r.body, kind });
      return send(res, 200, { ...r.body, peerUrl });
    }

    // Poll it. On approval the grant is SAVED here, because the token is handed
    // over exactly once and a page that happens to be reloading must not be how
    // it gets lost.
    if (url.pathname.startsWith("/v1/peers/ask/") && req.method === "GET") {
      if (!isOwner(req)) return send(res, 403, { error: "local only" });
      const id = url.pathname.slice("/v1/peers/ask/".length);
      const ask = access.getAsk(id);
      if (!ask) return send(res, 404, { error: "unknown ask" });
      const r = await peerFetch(
        `${ask.peerUrl}/v1/access/request/${id}?claim=${encodeURIComponent(ask.claim)}`,
      ).catch(() => ({ ok: false, status: 0, body: {} }));
      if (!r.ok) return send(res, 200, { state: "pending", unreachable: true });
      if (r.body.state === "approved" && r.body.token) {
        access.saveHeld({
          bridgeId: r.body.bridge?.id,
          hostName: r.body.bridge?.hostName,
          url: r.body.bridge?.url || ask.peerUrl,
          token: r.body.token,
          kind: r.body.kind,
          scope: r.body.scope,
          expiresAt: r.body.expiresAt,
          nodeId: r.body.bridge?.nodeId ?? null,
          relay: r.body.bridge?.relay ?? null,
          tunnelToken: r.body.bridge?.tunnelToken ?? null,
        });
      }
      if (r.body.state && r.body.state !== "pending") access.forgetAsk(id);
      return send(res, 200, { ...r.body, peerUrl: ask.peerUrl, code: ask.code });
    }

    // Read a peer's catalog with the preview grant we hold for it.
    if (url.pathname === "/v1/peers/catalog") {
      if (!isOwner(req)) return send(res, 403, { error: "local only" });
      const peerUrl = url.searchParams.get("peer");
      // The token is optional: when we already hold a grant on this peer, use
      // it. That is what lets the CLI say `pounce ask work-laptop` instead of
      // making a person carry a 64-hex credential between commands.
      const token = url.searchParams.get("token") || access.heldFor(peerUrl)?.token;
      if (!peerUrl || !token) return send(res, 400, { error: "no grant held for that peer" });
      const q = url.searchParams.get("q");
      const path = q ? `/v1/catalog/threads?q=${encodeURIComponent(q)}` : "/v1/catalog/spaces";
      const r = await peerFetch(`${peerUrl}${path}`, {
        headers: { authorization: `Bearer ${token}` },
      }).catch((e) => ({ ok: false, status: 502, body: { error: String(e?.message || e) } }));
      return send(res, r.ok ? 200 : r.status || 502, r.body);
    }

    // Access this machine holds on others.
    if (url.pathname === "/v1/peers/granted" && req.method === "GET") {
      if (!isOwner(req)) return send(res, 403, { error: "local only" });
      // Tokens stay here: the list is for showing who we can read, and the page
      // has no use for the credential itself.
      return send(res, 200, {
        held: access.listHeld().map(({ token, tunnelToken, ...rest }) => rest),
      });
    }
    if (url.pathname.startsWith("/v1/peers/granted/") && req.method === "DELETE") {
      if (!isOwner(req)) return send(res, 403, { error: "local only" });
      const id = decodeURIComponent(url.pathname.slice("/v1/peers/granted/".length));
      return send(res, 200, { ok: access.forgetHeld(id) });
    }

    if (url.pathname === "/v1/peers/dial" && req.method === "POST") {
      // Loopback only: this spawns an outbound tunnel on behalf of the app
      // sharing this machine, and is nobody else's business.
      if (!isOwner(req)) return send(res, 403, { error: "local only" });
      const { nodeId, relay, token } = await readBody(req);
      if (!nodeId || !token) return send(res, 400, { error: "nodeId and token required" });
      try {
        return send(res, 200, { port: await dialPeer(nodeId, relay ?? null, token) });
      } catch (e) {
        return send(res, 503, { error: String(e?.message || e) });
      }
    }
    // --- adding a machine over SSH ------------------------------------------
    // Loopback only, like /v1/peers/dial above: these spawn an SSH client as
    // this user, with this user's keys and ssh_config. Nobody on the LAN, and
    // no holder of a scoped grant, gets to reach for that.
    // Machines this computer already knows how to reach, so the form can offer
    // them instead of describing where to find them. Read fresh each time: a
    // host added to ~/.ssh/config while the app is open should show up on the
    // next Refresh, not the next launch.
    if (url.pathname === "/v1/ssh/hosts") {
      if (!isOwner(req)) return send(res, 403, { error: "local only" });
      return send(res, 200, { hosts: listSshHosts() });
    }
    if (url.pathname === "/v1/ssh/start" && req.method === "POST") {
      if (!isOwner(req)) return send(res, 403, { error: "local only" });
      const { host, user, sshPort, bridgePort, strictHostKey } = await readBody(req);
      if (!host) return send(res, 400, { error: "host required" });
      try {
        const run = startSshBootstrap({
          host,
          user: user || null,
          sshPort: sshPort || null,
          bridgePort: bridgePort || DEFAULT_PORT,
          strictHostKey: strictHostKey !== false,
        });
        return send(res, 200, run.state());
      } catch (e) {
        return send(res, 503, { error: String(e?.message || e) });
      }
    }
    // Live progress: phase changes, the prompt SSH is sitting on, and the raw
    // output so the app can show what a person would have seen in a terminal.
    if (url.pathname === "/v1/ssh/stream") {
      if (!isOwner(req)) return send(res, 403, { error: "local only" });
      const run = getSshBootstrap(url.searchParams.get("id"));
      if (!run) return send(res, 404, { error: "no such run" });
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      let closed = false;
      const write = (obj) => {
        if (!closed) res.write(`data: ${JSON.stringify(obj)}\n\n`);
      };
      // First frame is everything so far: a client that attaches after the
      // interesting part still paints the whole session.
      write({ ...run.state(), output: run.snapshot(), first: true });
      const detach = run.attach(write);
      const stop = () => {
        if (closed) return;
        closed = true;
        detach();
        clearInterval(beat);
        res.end();
      };
      // npx can sit silent for a minute while it downloads; without a comment
      // frame a proxy in between may decide the connection is dead.
      const beat = setInterval(() => {
        if (!closed) res.write(": ping\n\n");
      }, 25_000);
      req.on("close", stop);
      run.exited.finally(stop);
      return;
    }
    // Answering a prompt. The client sends the trailing newline: a host-key
    // answer is "yes\n", a password is the secret and a return.
    if (url.pathname === "/v1/ssh/input" && req.method === "POST") {
      if (!isOwner(req)) return send(res, 403, { error: "local only" });
      const { id, data } = await readBody(req);
      const run = getSshBootstrap(id);
      if (!run) return send(res, 404, { error: "no such run" });
      if (typeof data === "string" && data) run.write(data);
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/v1/ssh/status") {
      if (!isOwner(req)) return send(res, 403, { error: "local only" });
      const run = getSshBootstrap(url.searchParams.get("id"));
      if (!run) return send(res, 404, { error: "no such run" });
      return send(res, 200, run.state());
    }
    if (url.pathname === "/v1/ssh/cancel" && req.method === "POST") {
      if (!isOwner(req)) return send(res, 403, { error: "local only" });
      const { id } = await readBody(req);
      return send(res, 200, { ok: cancelSshBootstrap(id) });
    }
    if (url.pathname === "/v1/access" && req.method === "GET") {
      if (!isOwner(req)) return send(res, 403, { error: "local only" });
      sweepAccess();
      return send(res, 200, {
        pending: access.listPending(),
        grants: access.listGrants(),
        // Phones holding a credential of their own (devices.mjs). The old
        // `access.listDevices()` rows are a RECORD of a pairing, not a
        // credential, and could not be revoked individually — these can, so
        // they win where a device appears in both.
        devices: mergeDeviceRows(devices.list(), access.listDevices()),
      });
    }
    // Ending one device, without touching any other. The whole point of
    // per-device credentials: this used to require rotating the shared token.
    if (url.pathname === "/v1/devices/revoke" && req.method === "POST") {
      if (!isOwner(req)) return send(res, 403, { error: "local only" });
      const { id } = await readBody(req);
      if (!id) return send(res, 400, { error: "id required" });
      return send(res, 200, { ok: devices.revoke(id) });
    }
    if (url.pathname === "/v1/access/approve" && req.method === "POST") {
      if (!isOwner(req)) return send(res, 403, { error: "local only" });
      const { requestId, scope, expiresAt } = await readBody(req);
      // Only a `device` approval consumes this. It used to be the shared TOKEN,
      // which is what made "un-pair this phone" mean "rotate the credential and
      // end every other device" (access.mjs says so in listDevices). Minting the
      // approved phone its own credential makes that removal a single row.
      const pending = access.listPending().find((p) => p.id === requestId);
      const deviceToken =
        pending?.kind === "device"
          ? devices.mint({
              key: pending.requester?.bridgeId,
              name: pending.requester?.hostName,
              platform: pending.requester?.platform,
            }).token
          : null;
      const r = access.approve(requestId, {
        scope: scope === undefined ? undefined : (normalizeScope(scope) ?? { kind: "full" }),
        expiresAt: expiresAt ?? null,
        bridge: ownIdentity(),
        deviceToken,
      });
      if (!r.ok) return send(res, 400, r);
      // A device is now paired, exactly as if it had scanned the code — there is
      // no grant to tunnel or to show in the grants list.
      if (r.device) return send(res, 200, { ok: true, device: true });
      // Give the guest a way back in from another network. Best-effort: no
      // tunnel binary just means the grant is LAN-only.
      const tunnel = startGrantTunnel(r.grant.id);
      if (tunnel) access.setTunnel(r.grant.id, tunnel);
      return send(res, 200, { ok: true, grant: r.grant });
    }
    if (url.pathname === "/v1/access/deny" && req.method === "POST") {
      if (!isOwner(req)) return send(res, 403, { error: "local only" });
      const { requestId } = await readBody(req);
      return send(res, 200, access.deny(requestId));
    }
    if (url.pathname === "/v1/access/revoke" && req.method === "POST") {
      if (!isOwner(req)) return send(res, 403, { error: "local only" });
      const { grantId } = await readBody(req);
      const r = access.revoke(grantId);
      if (r.ok) stopGrantTunnel(grantId);
      return send(res, 200, r);
    }

    // --- the catalog a preview grant reads --------------------------------------
    // Names, counts and dates. Enough to decide what to ask for, and nothing a
    // thread's contents could be reconstructed from.
    // The owner reads the same catalog: it is exactly the list the approval
    // sheet has to show when picking which spaces and threads to grant, and
    // sharing the projection means the two ends can't drift apart on what a
    // space is called or how many threads it holds.
    // Any LIVE grant, not only a preview: a machine that already holds read
    // access is not a stranger, and making it re-run the stranger handshake to
    // ask for one more space is friction with no safety in it. See
    // CATALOG_ROUTES in agents/access.mjs for the bound on what this exposes.
    // (The grant is already proven live and route-checked by the time we get
    // here — an expired or revoked one 401s far above this.)
    const mayReadCatalog = (r) => !!r.grant || isOwner(r);
    if (url.pathname === "/v1/catalog/spaces") {
      if (!mayReadCatalog(req)) return send(res, 403, { error: "preview grant required" });
      return send(res, 200, { spaces: catalogSpaces(await getThreads()) });
    }
    if (url.pathname === "/v1/catalog/threads") {
      if (!mayReadCatalog(req)) return send(res, 403, { error: "preview grant required" });
      // `q` is REQUIRED. A preview is a lookup, not a dump: without this the
      // catalog would hand over every thread title on the machine in one call.
      const q = (url.searchParams.get("q") || "").trim().toLowerCase();
      if (!q) return send(res, 400, { error: "q required" });
      const repoKey = url.searchParams.get("space");
      const hits = (await getThreads())
        .filter((t) => (!repoKey || t.repo === repoKey) && (t.name || "").toLowerCase().includes(q))
        .sort((a, b) =>
          (b.lastActivityAt || b.createdAt || "").localeCompare(
            a.lastActivityAt || a.createdAt || "",
          ),
        )
        .slice(0, 25)
        .map(catalogThread);
      return send(res, 200, { threads: hits });
    }

    if (url.pathname === "/v1/agents")
      return send(res, 200, { agents: await getAgents(url.searchParams.get("fresh") === "1") });
    if (url.pathname === "/v1/threads") {
      const threads = await getThreads(url.searchParams.get("fresh") === "1");
      // A guest sees its scope and no evidence of the rest.
      return send(res, 200, {
        threads: req.grant ? filterThreads(await grantScope(req), threads) : threads,
      });
    }
    // SSE variant: emit each page of threads as it arrives so the app's initial
    // connect renders progressively instead of blocking until every page is
    // built. `data: {threads:[...]}` per page, then `data: {done:true}`.
    if (url.pathname === "/v1/threads/stream") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "access-control-allow-origin": "*",
      });
      const write = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      let closed = false;
      req.on("close", () => {
        closed = true;
      });
      // Resolved once for the whole stream rather than per page — the scope is
      // a property of the grant, and re-deriving it mid-stream would only let
      // pages disagree with each other.
      const scope = req.grant ? await grantScope(req) : null;
      try {
        await streamThreads((page) => {
          if (!closed) write({ threads: scope ? filterThreads(scope, page) : page });
        });
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
    // Full-text search over indexed session history. Results carry adapter
    // thread ids, so the app joins them against its synced thread list.
    if (url.pathname === "/v1/search") {
      const q = url.searchParams.get("q");
      if (!q) return send(res, 400, { error: "q required" });
      if (!historySearch.available()) {
        return send(res, 501, {
          error: "search unavailable",
          hint: "install ctx on this machine: https://ctx.rs",
        });
      }
      const agent = url.searchParams.get("agent") || undefined;
      const workspace = url.searchParams.get("workspace") || undefined;
      const since = url.searchParams.get("since") || undefined;
      const thread = url.searchParams.get("thread") || undefined;
      const limit = Number(url.searchParams.get("limit")) || 20;
      const providers = (await getAgents()).map((a) => a.id);
      const key = `search:${agent || "*"}:${workspace || "*"}:${since || "*"}:${thread || "*"}:${limit}:${q}`;
      const results = await cached(key, 15_000, () =>
        historySearch.search({ q, agent, workspace, since, thread, limit, providers }),
      );
      // Filtered AFTER the cache, never before: the cache key is the query, so
      // narrowing the search itself would let one grant's results be served to
      // another. Search reads message BODIES — the one route where leaking a
      // row leaks content, not just a title.
      if (req.grant) {
        const scope = await grantScope(req);
        if (!scope.full) {
          return send(res, 200, { results: results.filter((r) => scope.ids.has(r.threadId)) });
        }
      }
      return send(res, 200, { results });
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
      if (!agent || !thread || !ref)
        return send(res, 400, { error: "agent, thread, ref required" });
      const img = await host.getImage(agent, thread, ref).catch(() => null);
      if (!img) return send(res, 404, { error: "image not found" });
      // `mediaType` is TRANSCRIPT data, not ours: claude reads it from the
      // record's `source.media_type` and codex from the `data:` URL's own label
      // (`[^;,]+`, i.e. anything). Echoing it into Content-Type let a crafted
      // session serve `text/html` from the bridge's origin — script at
      // http://127.0.0.1:<port>, which can read /ui for the token and POST
      // /v1/exec past isOwnOrigin. Answer with a type from OUR list or not at
      // all, so a new adapter cannot reintroduce this by trusting its input.
      const IMAGE_TYPES = new Set([
        "image/png",
        "image/jpeg",
        "image/jpg",
        "image/gif",
        "image/webp",
        "image/bmp",
        "image/heic",
      ]);
      const type = String(img.mediaType || "").toLowerCase();
      if (!IMAGE_TYPES.has(type)) return send(res, 415, { error: "not an image" });
      res.writeHead(200, {
        "content-type": type,
        "cache-control": "private, max-age=86400",
        "access-control-allow-origin": "*",
        "x-content-type-options": "nosniff",
      });
      res.end(img.buffer);
      return;
    }
    if (url.pathname === "/v1/trajectory") {
      // Export a thread as ATIF (Harbor RFC 0001) so it can leave Pounce for a
      // bug report, an eval harness, or someone else's tooling. Read-only, and
      // built from the same events + official usage the app already sees.
      const agent = url.searchParams.get("agent");
      const thread = url.searchParams.get("thread");
      if (!agent || !thread) return send(res, 400, { error: "agent and thread required" });
      const [events, usage] = await Promise.all([
        getMessages(agent, thread, url.searchParams.get("fresh") === "1"),
        getUsage(agent, thread).catch(() => null),
      ]);
      if (!events.length) return send(res, 404, { error: "thread not found" });
      const doc = toAtif({
        agent,
        threadId: thread,
        events,
        usage: usage?.available ? usage : null,
        // ATIF's agent.version means the CLI that produced the trajectory.
        agentVersion: await binVersion(agent).catch(() => null),
        cwd: url.searchParams.get("cwd") || null,
      });
      if (url.searchParams.get("download") === "1") {
        // `agent` and `thread` are request parameters, so they do not belong in
        // a header value unescaped: a quote in either closes the filename early
        // and lets the rest of this header be written by the caller. Node
        // already refuses CR/LF (so no response splitting) — this is the rest.
        const safe = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, "_");
        res.setHeader(
          "content-disposition",
          `attachment; filename="${safe(agent)}-${safe(thread)}.atif.json"`,
        );
      }
      return send(res, 200, doc);
    }
    if (url.pathname === "/v1/file") {
      // Serve a local IMAGE file by absolute path — used to preview a Read of an
      // image (screenshot) in its tool card. Token-authed like every route, and
      // deliberately IMAGE-ONLY (never arbitrary files) so this can't exfiltrate
      // source/secrets. Streamed + size-capped.
      const IMG_MIME = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".bmp": "image/bmp",
        ".heic": "image/heic",
        ".svg": "image/svg+xml",
      };
      const p = url.searchParams.get("path");
      if (!p) return send(res, 400, { error: "path required" });
      const mime = IMG_MIME[path.extname(p).toLowerCase()];
      if (!mime) return send(res, 415, { error: "not an image" });
      let st;
      try {
        st = statSync(p);
      } catch {
        return send(res, 404, { error: "not found" });
      }
      if (!st.isFile() || st.size > 25 * 1024 * 1024) return send(res, 404, { error: "not found" });
      res.writeHead(200, {
        "content-type": mime,
        "cache-control": "private, max-age=86400",
        "access-control-allow-origin": "*",
        // An SVG is a DOCUMENT, not a bitmap: it can carry <script>, and this
        // route hands it back under the bridge's own origin. That was a way to
        // run script AT http://127.0.0.1:<port> — where /ui is same-origin
        // readable (so: the token) and a same-origin POST to /v1/exec passes
        // isOwnOrigin. A screenshot an agent was asked to Read is enough of a
        // foothold to get such a file on disk, so the file itself is untrusted.
        //
        // `sandbox` alone would do it; default-src 'none' also stops the
        // variant that merely beacons the file's existence out. nosniff is for
        // the other seven types — without it a mislabelled .png sniffed as HTML
        // reopens exactly the same hole.
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        "x-content-type-options": "nosniff",
      });
      createReadStream(p).pipe(res);
      return;
    }
    if (url.pathname === "/v1/context" && req.method !== "POST") {
      // A project's agent-instruction files (CLAUDE.md/AGENTS.md). Whitelist-
      // scoped by design — see agents/context.mjs.
      const cwd = url.searchParams.get("cwd");
      if (!cwd) return send(res, 400, { error: "cwd required" });
      const out = await readContextFiles(cwd);
      if (!out) return send(res, 404, { error: "not found" });
      return send(res, 200, out);
    }
    if (url.pathname === "/v1/context" && req.method === "POST") {
      // Save one context file. `mtime` is the version the client last read —
      // omit it to force, send it to be told (409) when an agent turn edited
      // the file underneath you rather than silently losing that edit.
      const body = await readBody(req);
      const { cwd, path: rel, content } = body;
      if (!cwd || !rel) return send(res, 400, { error: "cwd and path required" });
      // An ABSENT `mtime` means "force"; an explicit null means "I expect this
      // file not to exist yet". `in` is what tells those two apart.
      const expected = "mtime" in body ? body.mtime : undefined;
      const out = await writeContextFile(cwd, rel, content, expected);
      if (out.ok) return send(res, 200, { file: out.file });
      const status =
        out.error === "conflict"
          ? 409
          : out.error === "not found"
            ? 404
            : out.error === "write failed"
              ? 500
              : 400;
      return send(res, status, { error: out.error, mtime: out.file ?? null });
    }
    if (url.pathname === "/v1/doctor") {
      return send(res, 200, { report: await host.doctor() });
    }
    if (url.pathname === "/v1/config" && req.method === "GET") {
      return send(res, 200, { config: publicConfig(readConfig()) });
    }
    if (url.pathname === "/v1/config" && req.method === "POST") {
      // Manual overrides for custom setups: pin a binary's absolute path, add
      // PATH dirs, or set env vars. `bins`/`env` merge (""→clear a key). The
      // next spawn/probe picks these up (config is re-read on mtime change).
      const patch = await readBody(req);
      const config = writeConfig(patch || {});
      // Detection depends on these — drop the cached agent list/threads so the
      // next doctor/threads call reflects the new paths immediately.
      cache.delete("agents");
      cache.delete("threads");
      // A changed billing key invalidates both the memoized report and every
      // activity window that was built without (or with the old) one.
      if (patch && "adminApiKey" in patch) {
        resetCostCache();
        for (const k of [...cache.keys()]) if (k.startsWith("activity:")) cache.delete(k);
      }
      return send(res, 200, { config: publicConfig(config) });
    }
    if (url.pathname === "/v1/usage") {
      const agent = url.searchParams.get("agent");
      const thread = url.searchParams.get("thread");
      if (!agent || !thread) return send(res, 400, { error: "agent and thread required" });
      if (url.searchParams.get("fresh") === "1") cache.delete(`usage:${agent}:${thread}`);
      // `cwd` is still accepted from older clients but no longer needed — the
      // adapters resolve a thread's own records without being told where it ran.
      return send(res, 200, { usage: await getUsage(agent, thread) });
    }
    // Daily activity across every thread on this host — the dashboard series.
    // Tokens/messages/sessions come from the agents' own records; a dollar
    // figure appears only where an agent reported one (see activity-index).
    if (url.pathname === "/v1/activity") {
      const days = Math.min(400, Math.max(1, Number(url.searchParams.get("days") || 365)));
      const fresh = url.searchParams.get("fresh") === "1";
      // `repo` narrows the series to one repository's threads — the Spaces
      // page, which asks "what has this project cost me", not "what have I
      // done". It's the SAME transcript scan, just folded over fewer threads.
      const repo = url.searchParams.get("repo");
      const key = `activity:${days}:${repo ?? "*"}`;
      if (fresh) {
        cache.delete(key);
        // The billing report has its own 5-minute memo inside admin-cost.mjs.
        // Without this, someone who just fixed a rejected Admin key pulls to
        // refresh and still gets the stale "not authorized" answer.
        resetCostCache();
        // Same for the estimate, which also memos its (slower) transcript scan.
        resetCcusageCache();
      }
      return send(
        res,
        200,
        await cached(key, CACHE_MS, async () => {
          const all = await getThreads(fresh);
          if (repo) {
            // Ledger dollars only. The org billing report is per-workspace and
            // ccusage's estimate is per-day-across-everything: neither can say
            // which repo a dollar belongs to, so attributing either to one
            // project would be inventing the number this whole path avoids.
            return activity.series(
              all.filter((t) => t.repo === repo),
              { days, scoped: true },
            );
          }
          const series = await activity.series(all, { days });
          // One window bound for both ccusage reads below, so they share a
          // single memo entry and a single spawn instead of scanning twice.
          const since = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
          // Tokens first: ccusage owns the reading of every agent it supports,
          // and attaches the breakdown the Tokens card drills into.
          const counted = await withCcusageTokens(series, since);
          // Then dollars, cheapest-truth-last: estimate fills the holes, then
          // the billing report overwrites whatever it can speak for.
          return withAdminCost(await withEstimatedCost(counted, days, since), days);
        }),
      );
    }
    // Plan quota — how much of a rolling rate-limit window is spent. For a
    // subscription this is the meaningful number; "dollars" doesn't exist.
    if (url.pathname === "/v1/quota") {
      return send(
        res,
        200,
        await cached("quota", 60_000, async () => {
          const quota = await readQuota();
          // Claude publishes no meter, but its transcripts date every turn — so
          // the current rolling window and its burn rate ARE derivable. Attached
          // under `blocks` (never merged into `windows`) so the client can't
          // mistake a measurement of our own for a figure the agent reported.
          const blocks = await readBlocks().catch(() => null);
          if (blocks && quota[blocks.agent]) quota[blocks.agent].blocks = blocks;
          return { quota };
        }),
      );
    }
    if (url.pathname === "/v1/warm" && req.method === "POST") {
      // The app's ranking of which threads to keep hot (usage-predicted). We
      // pre-warm them in the background so opening one is instant.
      const body = await readBody(req);
      setWarmHints(body?.threads);
      // Warm immediately off the cached thread list so a just-updated ranking
      // doesn't wait for the next 15s tick.
      void getThreads()
        .then(warmMessages)
        .catch(() => {});
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/v1/turn" && req.method === "POST") {
      const body = await readBody(req);
      const { agent, threadId, text } = body;
      if (!agent || !threadId || !text)
        return send(res, 400, { error: "agent, threadId, text required" });
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
      try {
        entries = listDirs(dir);
      } catch {
        entries = [];
      }
      // At home or a filesystem root there is no "up" — path.dirname of a root
      // (/, C:\) returns itself, which would loop the folder browser forever.
      const up = path.dirname(dir);
      const parent = dir === home || up === dir ? null : up;
      return send(res, 200, { path: dir, parent, home, entries });
    }
    // --- Shell terminal (the app's terminal dock) -------------------------
    // A real login shell per thread, in that thread's folder. See
    // agents/term.mjs for why this is a separate registry from the agent PTYs.
    if (url.pathname === "/v1/term/open" && req.method === "POST") {
      const { id, cwd, cols, rows } = await readBody(req);
      if (!id) return send(res, 400, { error: "id required" });
      const shell = openShell(id, { cwd, cols, rows });
      return send(res, 200, {
        ok: true,
        cwd: shell.cwd,
        cols: shell.pty.cols,
        rows: shell.pty.rows,
      });
    }
    // Live output. `format=cells` (default) streams the rendered screen; the
    // first frame is the WHOLE screen so a reconnecting client paints what's
    // already there, and every frame after it carries only changed rows.
    // `format=raw` streams the PTY's bytes for a client with its own emulator.
    if (url.pathname === "/v1/term/stream") {
      const id = url.searchParams.get("id");
      const format = url.searchParams.get("format") === "raw" ? "raw" : "cells";
      const shell = id ? getShell(id) : null;
      if (!shell) return send(res, 404, { error: "no shell" });
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "access-control-allow-origin": "*",
      });
      let closed = false;
      const write = (obj) => {
        if (!closed) res.write(`data: ${JSON.stringify(obj)}\n\n`);
      };
      const sink = { format, send: write };
      // Raw clients get the scrollback so far; cell clients get the painted
      // screen. Either way the first message is "here is the current state".
      if (format === "raw") write({ raw: shell.pty.snapshot(), first: true });
      else write({ ...shell.snapshot(), first: true });
      const detach = shell.attach(sink);
      // The shell outlives the stream, so a dead connection must let go of its
      // sink or the fan-out grows one entry per reconnect.
      const stop = () => {
        if (closed) return;
        closed = true;
        detach();
        clearInterval(beat);
        res.end();
      };
      // Comment frames keep an idle connection from being reaped by a proxy or
      // by the tunnel; a shell can sit silent for hours.
      const beat = setInterval(() => {
        if (!closed) res.write(": ping\n\n");
      }, 25_000);
      req.on("close", stop);
      shell.exited.finally(() => {
        write({ exited: true });
        stop();
      });
      return;
    }
    // Keystrokes. Raw bytes, straight through — the client owns key encoding
    // (it knows whether the app is in cursor-key application mode).
    if (url.pathname === "/v1/term/input" && req.method === "POST") {
      const { id, data } = await readBody(req);
      const shell = id ? getShell(id) : null;
      if (!shell) return send(res, 404, { error: "no shell" });
      if (typeof data === "string" && data) shell.write(data);
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/v1/term/resize" && req.method === "POST") {
      const { id, cols, rows } = await readBody(req);
      const shell = id ? getShell(id) : null;
      if (!shell) return send(res, 404, { error: "no shell" });
      if (cols > 0 && rows > 0) shell.resize(Math.min(500, cols), Math.min(200, rows));
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/v1/term/close" && req.method === "POST") {
      const { id } = await readBody(req);
      return send(res, 200, { ok: id ? closeShell(id) : false });
    }
    // Editors installed on THIS machine, for the desktop app's "Open in" menu.
    // A list rather than the client guessing: an entry that launches nothing is
    // worse than an absent one.
    if (url.pathname === "/v1/editors") {
      return send(res, 200, { editors: listEditors() });
    }
    // Open a project folder in one of them. Purpose-built rather than an
    // /v1/exec shell string so the path is passed as an argument and never
    // interpolated — see agents/editors.mjs.
    if (url.pathname === "/v1/open" && req.method === "POST") {
      const { editor, cwd } = await readBody(req);
      if (!editor) return send(res, 400, { error: "editor required" });
      const r = openIn(editor, cwd);
      return send(res, r.ok ? 200 : 400, r);
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
      const info = tunnelEligible() ? tunnelInfo() : null;
      return send(
        res,
        200,
        info
          ? {
              pairing: {
                nodeId: info.nodeId,
                token: TOKEN,
                hostName: os.hostname().replace(/\.local$/, ""),
                relay: info.relay,
              },
            }
          : { pairing: null, error: "tunnel not running" },
      );
    }
    if (url.pathname === "/v1/tunnel/ensure") {
      // (Re)spawn pounce-tunnel if a binary is available and it isn't running —
      // the CLI calls this after dropping a freshly downloaded binary into
      // ~/.pounce/bin so an already-running bridge picks it up without a
      // restart. Idempotent; also the poll target for "is off-LAN ready yet".
      // `eligible` mirrors ensureTunnel's singleton guard: the machine-wide
      // tunnel identity targets the default-port bridge only, so a dev bridge
      // on another port must not advertise it (the QR would route the phone to
      // the wrong bridge).
      ensureTunnel();
      const eligible = tunnelEligible();
      return send(res, 200, {
        eligible,
        running: !!tunnelChild,
        binary: tunnelBinary(),
        tunnel: eligible ? tunnelInfo() : null,
      });
    }
    // --- what tunnel is this machine running, and is it the newest? ------------
    // Deliberately a NORMAL authenticated route, not an owner-only one: the
    // whole point is that a phone or desktop can ask a remote server this over
    // the very tunnel being reported on. A scoped grant holder can read it too,
    // which is harmless — it is a version number, and they can already tell
    // which protocol they connected with.
    if (url.pathname === "/v1/tunnel/version") {
      const current = tunnelVersion();
      const body = {
        installed: !!tunnelBinary(),
        running: !!tunnelChild,
        version: current?.version ?? null,
        proto: current?.proto ?? null,
        // How we know. `stamp` means the binary predates `version`; `unknown`
        // means we have one and can't identify it. The fleet view shows the
        // difference rather than printing a confident null.
        source: current?.source ?? null,
        lastUpdate: tunnelUpdateState(),
        latest: null,
        updateAvailable: null,
      };
      // Only reach for GitHub when asked — a sync must not spend a rate-limited
      // API call per device per refresh.
      if (url.searchParams.get("check") === "1") {
        try {
          const latest = await latestTunnelRelease();
          body.latest = latest?.version ?? null;
          body.updateAvailable =
            !!latest?.version &&
            (body.version === null || compareVersions(body.version, latest.version) < 0);
        } catch (e) {
          body.checkError = String(e?.message || e);
        }
      }
      return send(res, 200, body);
    }

    // --- replace it ------------------------------------------------------------
    if (url.pathname === "/v1/tunnel/update" && req.method === "POST") {
      // A paired device may do this; a guest holding a scoped read grant may
      // not. Replacing the binary that carries this machine's networking is an
      // owner's act, and "can read my threads until Tuesday" is not that.
      if (req.grant) return send(res, 403, { error: "forbidden_for_grant" });
      if (!tunnelEligible()) {
        return send(res, 409, {
          error:
            "this bridge does not own the machine's tunnel identity (non-default port without POUNCE_TUNNEL=1)",
        });
      }
      if (tunnelUpdateState()?.state === "updating") {
        return send(res, 409, {
          error: "an update is already running",
          state: tunnelUpdateState(),
        });
      }
      // Answer BEFORE touching anything. Restarting `serve` kills the
      // connection this request arrived on when it came in over the tunnel, so
      // a reply sent afterwards would never be read. The caller re-dials — the
      // node id is unchanged — and reads /v1/tunnel/version to see how it went.
      send(res, 202, {
        accepted: true,
        from: tunnelVersion()?.version ?? null,
        note: "The tunnel will restart. Re-dial and read /v1/tunnel/version for the result.",
      });
      void updateTunnelBinary();
      return;
    }

    if (url.pathname === "/v1/git/changes") {
      const cwd = url.searchParams.get("cwd");
      if (!cwd || !existsSync(cwd)) return send(res, 200, { branch: null, files: [], diff: "" });
      return send(res, 200, await gitChanges(cwd));
    }
    if (url.pathname === "/v1/git/checks") {
      const cwd = url.searchParams.get("cwd");
      if (!cwd || !existsSync(cwd)) return send(res, 200, { checks: null, failed: 0, total: 0 });
      // gh hits the GitHub API — cache briefly so reopening the sheet is instant.
      return send(res, 200, await cached(`checks:${cwd}`, 30_000, () => gitChecks(cwd)));
    }
    if (url.pathname === "/v1/git/commit" && req.method === "POST") {
      const { cwd, message } = await readBody(req);
      if (!cwd || !message) return send(res, 400, { error: "cwd, message required" });
      const add = await git(cwd, ["add", "-A"]);
      if (add.code !== 0) return send(res, 200, { ok: false, error: add.err || "git add failed" });
      const commit = await git(cwd, ["commit", "-m", message]);
      if (commit.code !== 0)
        return send(res, 200, {
          ok: false,
          error: commit.err || commit.out || "nothing to commit",
        });
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
    if (url.pathname === "/v1/git/suggest" && req.method === "POST") {
      const { cwd } = await readBody(req);
      if (!cwd || !existsSync(cwd)) return send(res, 400, { error: "cwd required" });
      return send(res, 200, await gitSuggest(cwd));
    }
    if (url.pathname === "/v1/git/branch" && req.method === "POST") {
      // Create + switch to a new branch (used before committing work made on main).
      const { cwd, name } = await readBody(req);
      if (!cwd || !name) return send(res, 400, { error: "cwd, name required" });
      const r = await git(cwd, ["checkout", "-b", name]);
      return send(res, 200, {
        ok: r.code === 0,
        error: r.code === 0 ? undefined : (r.err || r.out).trim(),
      });
    }
    if (url.pathname === "/v1/git/pr" && req.method === "POST") {
      const { cwd, title, body, draft } = await readBody(req);
      if (!cwd) return send(res, 400, { error: "cwd required" });
      // Ensure the branch is pushed first, then open a PR via gh (if installed).
      let push = await git(cwd, ["push", "-u", "origin", "HEAD"]);
      const r = await exec(
        "gh",
        [
          "pr",
          "create",
          "--fill",
          ...(draft ? ["--draft"] : []),
          ...(title ? ["--title", title] : []),
          ...(body ? ["--body", body] : []),
        ],
        cwd,
      );
      if (r.code !== 0)
        return send(res, 200, {
          ok: false,
          error: r.err || "gh not available or PR failed",
          pushed: push.code === 0,
        });
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
    // Settled threads — the inbox gesture. The whole map comes back on every
    // write so a client never has to guess what the machine now believes; it is
    // one small string per settled thread (see agents/settled.mjs).
    if (url.pathname === "/v1/settled" && req.method === "GET") {
      return send(res, 200, { settled: listSettled() });
    }
    if (url.pathname === "/v1/settled" && req.method === "POST") {
      const { threadId, state, at } = await readBody(req);
      if (!threadId) return send(res, 400, { error: "threadId required" });
      if (state != null && state !== "settled" && state !== "active") {
        return send(res, 400, { error: "state must be settled, active or null" });
      }
      // `state: null` clears the override and hands the thread back to the
      // automatic rule. The CLIENT's timestamp is stored, not ours: it has to
      // be comparable with the thread's own updatedAt, and a server clock a
      // second behind would settle a thread "before" its last message.
      setSettled(threadId, state ?? null, at || undefined);
      return send(res, 200, { ok: true, settled: listSettled() });
    }

    // Markers — the user's jump-to points in a thread. Overrides only; the
    // client still computes the default for every event (see agents/markers.mjs).
    if (url.pathname === "/v1/markers" && req.method === "GET") {
      const thread = url.searchParams.get("thread") || null;
      return send(res, 200, { markers: await listMarkers(thread) });
    }
    if (url.pathname === "/v1/markers" && req.method === "POST") {
      const { threadId, eventId, marked } = await readBody(req);
      if (!threadId || !eventId) return send(res, 400, { error: "threadId and eventId required" });
      await setMarker(threadId, eventId, marked === null ? null : !!marked);
      return send(res, 200, { ok: true, markers: await listMarkers(threadId) });
    }
    // Whole-thread replace: the app owns the full override set for a thread it
    // has open, so a sync pushes the thread rather than diffing. Idempotent.
    if (url.pathname === "/v1/markers/thread" && req.method === "PUT") {
      const { threadId, markers } = await readBody(req);
      if (!threadId) return send(res, 400, { error: "threadId required" });
      const n = await replaceThreadMarkers(threadId, markers || []);
      return send(res, 200, { ok: true, count: n });
    }
    if (url.pathname === "/v1/markers" && req.method === "DELETE") {
      const thread = url.searchParams.get("thread");
      if (!thread) return send(res, 400, { error: "thread required" });
      return send(res, 200, { ok: true, cleared: await clearThreadMarkers(thread) });
    }
    if (url.pathname === "/v1/turn/permission" && req.method === "POST") {
      const { requestId, optionId } = await readBody(req);
      if (!requestId) return send(res, 400, { error: "requestId required" });
      const ok = resolvePermission(requestId, optionId ?? null);
      return send(res, 200, { ok });
    }
    if (url.pathname === "/v1/session/prompt/answer" && req.method === "POST") {
      // Answer a pending interactive prompt on a PTY-hosted session by selecting
      // an option (trust / permission / plan / AskUserQuestion / any menu).
      const { threadId, optionIndex } = await readBody(req);
      if (!threadId || !Number.isInteger(optionIndex))
        return send(res, 400, { error: "threadId, optionIndex required" });
      const ok = await answerPrompt(threadId, optionIndex);
      if (ok) cache.delete("threads"); // activity changes as the turn resumes
      return send(res, 200, { ok });
    }
    if (url.pathname === "/v1/session/input" && req.method === "POST") {
      // Raw keystrokes / text into a PTY-hosted session — the escape hatch for
      // free-form prompts, ↑/↓ steering, Esc, Ctrl-C. `data` is written verbatim.
      const { threadId, data } = await readBody(req);
      if (!threadId || typeof data !== "string")
        return send(res, 400, { error: "threadId, data required" });
      const ok = sendInput(threadId, data);
      if (ok) cache.delete("threads");
      return send(res, 200, { ok });
    }
    if (url.pathname === "/v1/session/interactive" && req.method === "POST") {
      // Launch claude's TUI in a PTY so its interactive prompts (AskUserQuestion,
      // …) are answerable from the app. Returns the real threadId.
      const { threadId, text, cwd, model } = await readBody(req);
      if (!text) return send(res, 400, { error: "text required" });
      const id = startInteractiveSession({ threadId, text, cwd, model });
      cache.delete("threads");
      return send(res, 200, { threadId: id });
    }
    if (url.pathname === "/v1/turn/interrupt" && req.method === "POST") {
      const { agent, threadId } = await readBody(req);
      if (!agent || !threadId) return send(res, 400, { error: "agent, threadId required" });
      const ok = await interruptTurn(agent, threadId);
      return send(res, 200, { ok });
    }
    if (url.pathname === "/v1/turn/stream" && req.method === "POST") {
      const { agent, threadId, text, cwd, images, permissionMode, reasoningEffort, model } =
        await readBody(req);
      if (!agent || !text) return send(res, 400, { error: "agent, text required" });
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "access-control-allow-origin": "*",
      });
      let closed = false;
      const write = (obj) => {
        if (!closed) {
          try {
            res.write(`data: ${JSON.stringify(obj)}\n\n`);
          } catch {}
        }
      };
      // Mark the bridge busy until the TURN completes — not until the stream
      // closes — so a daemon restart won't cut the turn off mid-flight.
      activeTurns++;
      let settled = false;
      const settle = () => {
        if (!settled) {
          settled = true;
          activeTurns = Math.max(0, activeTurns - 1);
        }
      };
      streamTurn(
        agent,
        threadId,
        text,
        cwd,
        (ev) => write({ event: ev }),
        (realThreadId) => {
          // The streamed turn changed this thread's history — drop the cache so
          // the app's post-turn refetch (and the next open) reads it fresh.
          if (realThreadId) {
            cache.delete(`usage:${agent}:${realThreadId}`); // token totals grew this turn
          }
          cache.delete("threads");
          settle();
          write({ done: true, threadId: realThreadId });
          if (!closed) {
            try {
              res.end();
            } catch {}
          }
        },
        { images, permissionMode, reasoningEffort, model },
      );
      // A dropped stream (cellular blip, backgrounded app, tunnel hiccup) must
      // NOT kill the running turn — the agent keeps working, the transcript
      // persists, and the phone catches up via sync. Interrupting is explicit:
      // POST /v1/turn/interrupt (the app's stop button).
      req.on("close", () => {
        closed = true;
      });
      return;
    }
    return send(res, 404, { error: "not found" });
  } catch (e) {
    return send(res, 500, { error: String(e?.message || e) });
  }
});

function localIp() {
  return primaryLanIp();
}

// True if something already accepts connections on the port (a running bridge).
function portInUse(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    sock.setTimeout(1500);
    sock.once("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.once("timeout", () => {
      sock.destroy();
      resolve(false);
    });
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
      PAIR = { ip: ip || "localhost", port, pairUrl };
      // The tunnel identity is stable (persistent key), so a tunnel.json from a
      // previous run already names this host — the boot QR is remote-ready on
      // every run after the first.
      const deepLink = pairDeepLink();
      PAIR.deepLink = deepLink;
      if (!quiet) {
        console.log(`Pounce Bridge listening on ${pairUrl}`);
        console.log(`  token: ${TOKEN}`);
        console.log("  agents: native host");
        // Say out loud whether we got a real TTY. The pipe fallback is a silent
        // downgrade — interactive/answerable sessions still "work" but TUIs
        // don't render and SSH add-machine refuses to run — and it once shipped
        // undetected in the packaged app for want of exactly this line.
        console.log(
          ptyNative
            ? "  pty: native (real TTY)"
            : "  pty: pipe fallback — no native addon, interactive sessions degrade",
        );
        console.log("\n  📲 Scan with your iPhone Camera to pair Pounce:\n");
        qrcode.generate(deepLink, { small: true });
        console.log(`\n  …or open this link on the device:\n  ${deepLink}\n`);
      }
      // Warm the data cache so the first phone sync is instant (the probe
      // handshakes happen now, before anyone scans), then keep it warm while a
      // phone is actively connected. Idle = no probing.
      const warm = () => {
        void getAgents().catch(() => {});
        void getThreads()
          .then(warmMessages)
          .catch(() => {});
      };
      warm();
      setInterval(() => {
        if (Date.now() - lastClientSeen < 90_000) warm();
      }, 15_000);
      setTimeout(watchTick, WATCH_MS);
      startActivityPopulate();
      ensureTunnel();
      // Tell the LAN this machine is here, and start the clock on any grants
      // that outlived the last run — a bridge restart must not silently extend
      // access someone gave until Tuesday.
      syncDiscovery();
      sweepAccess();
      setInterval(sweepAccess, 60_000).unref?.();
      // Shell terminals nobody is watching. A dock opened once on a thread you
      // never went back to would otherwise hold a login shell for the life of
      // the bridge.
      setInterval(reapShells, 5 * 60_000).unref?.();
      restoreGrantTunnels();
      resolve({ server, token: TOKEN, ...PAIR });
    });
  });
}

// --- pounce-tunnel (off-LAN access) -------------------------------------------
// The Rust tunnel (apps/tunnel) accepts Iroh QUIC streams from the phone and
// proxies them to this bridge, so the app works from anywhere. Its identity
// lands in ~/.pounce/tunnel.json, which /v1/pair serves. Best-effort: no
// binary → LAN-only, exactly as before.
// Resolution and download both live in agents/tunnel-bin.mjs — `serve` looks
// for a binary that's already there, while `client` (dialPeer) will fetch one,
// because the desktop can now be asked to dial a machine on a Mac that has
// never had a reason to download it.

// --- per-grant tunnels ---------------------------------------------------------
// A guest that leaves the network still needs a way in, and the machine-wide
// tunnel won't do: its QUIC handshake is gated on the BRIDGE's token, which a
// guest holding only a grant does not have. So each grant gets its own `serve`
// process — own identity key, own handshake secret, own node id. Revoking the
// grant kills the process, which closes the door at the transport layer and not
// merely at HTTP. Grants are a handful, so a process each is cheap.

const GRANT_DIR = path.join(os.homedir(), ".pounce", "grants");

/** grantId -> ChildProcess */
const grantTunnels = new Map();

/** Read back the node id `serve` wrote for a grant. It writes asynchronously at
 *  startup, so an immediate read misses — callers poll. */
function grantTunnelInfo(grantId) {
  try {
    const info = JSON.parse(readFileSync(path.join(GRANT_DIR, `${grantId}.json`), "utf8"));
    return info?.nodeId ? { nodeId: info.nodeId, relay: info.relay || null } : null;
  } catch {
    return null;
  }
}

/**
 * Start (or reuse) a grant's tunnel. Returns its identity once `serve` has
 * published one, else null — a machine with no tunnel binary simply has
 * LAN-only grants, which is a smaller feature rather than a broken one.
 */
function startGrantTunnel(grantId) {
  if (grantTunnels.has(grantId)) return grantTunnelInfo(grantId);
  const bin = tunnelBinary();
  const secret = access.tunnelSecret(grantId);
  if (!bin || !secret) return null;
  try {
    mkdirSync(GRANT_DIR, { recursive: true, mode: 0o700 });
    const child = spawn(
      bin,
      [
        "serve",
        "--token",
        secret,
        "--target",
        `127.0.0.1:${PORT}`,
        "--key",
        path.join(GRANT_DIR, `${grantId}.key`),
        "--info",
        path.join(GRANT_DIR, `${grantId}.json`),
      ],
      { stdio: ["ignore", "ignore", "ignore"], windowsHide: true },
    );
    grantTunnels.set(grantId, child);
    child.on("close", () => {
      // Only forget it if this is still the current child — a restart that
      // already replaced it must not be unregistered by its predecessor.
      if (grantTunnels.get(grantId) === child) grantTunnels.delete(grantId);
    });
    // The identity file appears a moment after spawn; publish it to the grant
    // when it does, so the guest's next poll carries it.
    let tries = 0;
    const poll = setInterval(() => {
      const info = grantTunnelInfo(grantId);
      if (info || ++tries > 20) {
        clearInterval(poll);
        if (info) access.setTunnel(grantId, info);
      }
    }, 500);
    poll.unref?.();
  } catch {
    grantTunnels.delete(grantId);
  }
  return grantTunnelInfo(grantId);
}

/** Tear a grant's tunnel down and delete its identity, so a later grant can
 *  never be reached at a revoked one's node id. */
function stopGrantTunnel(grantId) {
  const child = grantTunnels.get(grantId);
  grantTunnels.delete(grantId);
  try {
    child?.kill("SIGTERM");
  } catch {}
  for (const ext of ["key", "json"]) {
    try {
      rmSync(path.join(GRANT_DIR, `${grantId}.${ext}`), { force: true });
    } catch {}
  }
}

/** Bring back the tunnels of grants that survived a restart. Runs after the
 *  expiry sweep, so a lapsed grant is never handed a fresh door. */
function restoreGrantTunnels() {
  for (const g of access.listGrants()) {
    if (g.tunnel) startGrantTunnel(g.id);
  }
}

// --- dialing OUT to a peer ------------------------------------------------------
// The mobile app carries the tunnel client as a native module, so it dials peers
// itself. The desktop app has no such module — but it does have this bridge
// sitting on the same machine, which can run `pounce-tunnel client` on its
// behalf and hand back a loopback port that speaks plain HTTP.

/** `${nodeId}` -> { proc, port } */
const peerDials = new Map();

/** An OS-assigned free port, asked for and released before we hand it to the
 *  tunnel. Racy in principle; in practice nothing else is grabbing ports in the
 *  microseconds between, and `client` fails loudly if it loses. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Start (or reuse) a loopback proxy to a peer's tunnel. */
async function dialPeer(nodeId, relay, token) {
  const hit = peerDials.get(nodeId);
  if (hit) return hit.port;
  // Fetch it if we haven't got it: this is the dialling side, and a machine
  // added over SSH is reachable only through the tunnel.
  const bin = await ensureTunnelBinary();
  if (!bin) {
    throw new Error(
      `no tunnel binary on this machine${lastTunnelError() ? ` (${lastTunnelError()})` : ""}`,
    );
  }
  const port = await freePort();
  const args = ["client", "--token", token, "--node", nodeId, "--listen", `127.0.0.1:${port}`];
  if (relay) args.push("--relay", relay);
  const proc = spawn(bin, args, { stdio: ["ignore", "ignore", "ignore"], windowsHide: true });
  peerDials.set(nodeId, { proc, port });
  proc.on("close", () => {
    if (peerDials.get(nodeId)?.proc === proc) peerDials.delete(nodeId);
  });
  return port;
}

let tunnelChild = null;
let tunnelBackoffMs = 1000;
/** The stale-instance sweep below is a boot-time measure, and must stay one:
 *  it matches every `pounce-tunnel serve`, which after this bridge has been up
 *  a while includes its own guests' tunnels. */
let sweptStaleTunnels = false;
function ensureTunnel() {
  if (tunnelChild) return;
  // The tunnel identity (~/.pounce/tunnel.key → one node id) is a SINGLETON:
  // every `pounce-tunnel serve` claims the same node id, and the relay routes
  // the phone to whichever instance registered last. So (a) only the bridge
  // the phone actually paired with — the default-port one — may run it; a dev
  // bridge on another port would hijack the identity and blackhole the phone's
  // off-LAN traffic into its own (soon-dead) port. Set POUNCE_TUNNEL=1 to opt
  // a non-default bridge in deliberately.
  if (PORT !== DEFAULT_PORT && process.env.POUNCE_TUNNEL !== "1") return;
  const bin = tunnelBinary();
  if (!bin) return; // no tunnel installed — LAN-only
  // (b) Sweep stale instances before claiming the identity: crashed/killed
  // bridges orphan their tunnels (SIGKILL skips the exit handler), and dozens
  // of zombies fighting over one node id made off-LAN a lottery.
  //
  // ONCE, at boot. The pattern matches every `pounce-tunnel serve`, and each
  // live grant now runs one of its own (see startGrantTunnel) — so re-sweeping
  // from /v1/tunnel/ensure later would cut off every guest currently connected
  // over the tunnel. At boot there are no guest tunnels yet; restoreGrantTunnels
  // brings them up after this has run.
  if (!IS_WIN && !sweptStaleTunnels) {
    sweptStaleTunnels = true;
    try {
      execFileSync("pkill", ["-f", "pounce-tunnel serve"], { stdio: "ignore" });
    } catch {} // exit 1 = no matches
  }
  try {
    tunnelChild = spawn(bin, ["serve", "--token", TOKEN, "--target", `127.0.0.1:${PORT}`], {
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
    });
    tunnelChild.on("close", () => {
      tunnelChild = null;
      // Respawn with backoff — a crashing tunnel must not loop hot.
      setTimeout(ensureTunnel, Math.min((tunnelBackoffMs *= 2), 60_000)).unref();
    });
    tunnelChild.on("spawn", () => {
      tunnelBackoffMs = 1000;
    });
    console.log(`[tunnel] started ${bin}`);
  } catch {
    tunnelChild = null;
  }
}
// --- updating the tunnel binary underneath ourselves -----------------------------
// The hard part of this whole feature. On a remote server the update arrives
// THROUGH the tunnel it replaces: restarting `serve` drops the very connection
// carrying the request, so the caller can never be told how it went over that
// channel. Two things make it survivable.
//
// The identity key (~/.pounce/tunnel.key) is not touched, so the node id is the
// SAME after the restart — the caller can re-dial the machine it was already
// talking to and ask. And the binary we replaced is kept, so a new one that
// won't run can be undone from here rather than needing somebody to find an SSH
// client. Neither makes the update transactional; together they make it
// recoverable, which on a machine you may not be able to reach again is the
// property that actually matters.

/** How the last update went, for the caller that comes back to ask. */
let lastTunnelUpdate = null;

export function tunnelUpdateState() {
  return lastTunnelUpdate;
}

/**
 * Restart `serve` onto whatever binary is now at the path.
 *
 * The close handler must not race us: left attached it respawns on a backoff of
 * its own, and we would end up with two processes claiming one identity — the
 * exact lottery ensureTunnel's boot-time sweep exists to prevent. So it is
 * detached, and the respawn is ours to do.
 *
 * The pause is not cosmetic. SIGTERM is a request, and a `serve` still holding
 * the identity when its replacement registers means the relay routes to
 * whichever got there last — which may be the process we just told to die.
 */
async function restartTunnel() {
  const child = tunnelChild;
  tunnelChild = null; // ensureTunnel's guard, and the handler's, both read this
  try {
    child?.removeAllListeners("close");
    child?.kill("SIGTERM");
  } catch {}
  if (child) await new Promise((r) => setTimeout(r, 500));
  ensureTunnel();
}

/** Did `serve` come back up and republish an identity? That — not the process
 *  merely existing — is the test: a binary that starts and immediately fails to
 *  bind is exactly the failure we are guarding against. */
async function tunnelBackUp(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    if (tunnelChild && tunnelInfo()?.nodeId) return true;
  }
  return false;
}

/**
 * Download the newest tunnel, swap it in, and restart `serve` on it — rolling
 * back if the result can't stand up.
 *
 * Runs detached from the request that asked for it: see above, that request's
 * connection is a casualty of the restart. The sequence itself lives in
 * agents/tunnel-update.mjs, where it can be tested against a machine that
 * refuses to come back up without needing one.
 */
async function updateTunnelBinary() {
  const startedAt = new Date().toISOString();
  lastTunnelUpdate = {
    state: "updating",
    from: tunnelVersion()?.version ?? null,
    to: null,
    startedAt,
    error: null,
  };
  const result = await runTunnelUpdate({
    currentVersion: () => tunnelVersion()?.version ?? null,
    install: fetchTunnel,
    restart: restartTunnel,
    isUp: tunnelBackUp,
    rollback: rollbackTunnel,
    log: (m) => console.log(m),
  });
  lastTunnelUpdate = { ...result, startedAt, finishedAt: new Date().toISOString() };
  return lastTunnelUpdate;
}

/** Every tunnel this bridge is responsible for: the machine-wide one and each
 *  live grant's. Left running they squat on identities the next boot re-claims. */
function killAllTunnels() {
  try {
    tunnelChild?.kill("SIGTERM");
  } catch {}
  for (const child of grantTunnels.values()) {
    try {
      child.kill("SIGTERM");
    } catch {}
  }
  for (const child of peerDials.values()) {
    try {
      child.proc.kill("SIGTERM");
    } catch {}
  }
}

process.on("exit", killAllTunnels);
// Shells are children of this process; without this they survive as orphans
// holding the thread's worktree open.
process.on("exit", killAllShells);
// An SSH child outliving the bridge would sit holding a TTY nobody can reach.
process.on("exit", killAllSshBootstraps);
// Default signal deaths bypass the exit handler — reap the tunnel explicitly
// so Ctrl-C'd bridges stop leaving identity-squatting orphans behind.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    killAllTunnels();
    process.exit(0);
  });
}

// When run directly (node server.mjs / the pounce-bridge bin), start immediately
// with the console QR. When imported (desktop app), the caller starts it.
// pathToFileURL (not string concat) so Windows paths (C:\…) compare correctly.
const isMain = (() => {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();
if (isMain) void startBridge();
