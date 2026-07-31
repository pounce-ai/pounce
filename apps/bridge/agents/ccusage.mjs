/**
 * ccusage — the ESTIMATED-cost source of last resort.
 *
 * Where it sits in the hierarchy: an agent's own reported dollars win, then the
 * org's billing report (./admin-cost.mjs), and only where BOTH are silent does
 * a number from here appear — tagged `costSource: "ccusage-est"` so the UI can
 * mark it. Nothing here ever overwrites a figure someone actually billed.
 *
 * What it is: https://github.com/ccusage/ccusage, the de-facto standard reader
 * for coding-agent usage on disk. It prices tokens at each model's PUBLISHED
 * LIST RATE (via LiteLLM's table), which is the crucial caveat — for a Max or
 * Plus seat the marginal cost of a turn is zero and this will still quote
 * dollars. That's why it fills gaps rather than replacing ./cost-ledger.mjs.
 *
 * Contract, verified against v20 rather than the docs (which describe the old
 * v15 JS library — v20 ships a single native executable per platform and has no
 * importable API, so this shells out):
 *
 *   ccusage session --json -i <id>        → { session: [row], totals }
 *   ccusage daily   --json --by-agent -s  → { daily:   [row], totals }
 *
 *   • a row's `period` is the session id for `session` and YYYY-MM-DD for
 *     `daily`; the session id is the same string Pounce uses as a thread id
 *     (verified: Claude UUIDs, opencode `ses_…`)
 *   • every row carries `agent`, and `daily --by-agent` nests an `agents[]`
 *   • no match is `null` on stdout with exit 0 — not an error, not an empty array
 *   • Cursor is NOT among its ~20 agents, so cursor threads never resolve here
 *
 * Two traps, both found by measurement:
 *   1. `-O/--offline` claims to use cached pricing but ships no table and writes
 *      no cache — it simply returns 0 for everything. We never pass it, which
 *      means pricing needs network.
 *   2. Following from (1), a row can come back with real tokens and cost 0 when
 *      pricing was unavailable. `0` from this module therefore means "unpriced"
 *      and is reported as null; a genuinely free model is indistinguishable, and
 *      showing nothing beats showing a confident $0.00.
 */
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { agentEnv } from "./env.mjs";
import { binOverride } from "./config.mjs";

const EXE = process.platform === "win32" ? "ccusage.exe" : "ccusage";

/** A full-history `daily` pass measured ~2s over a year of transcripts; a single
 *  `session` lookup ~0.5s. The ceiling is for a cold machine with far more. */
const TIMEOUT_MS = 30_000;

/** Same memo window as the billing report: this is a dashboard, and re-scanning
 *  every transcript on each pull-to-refresh would be gratuitous. */
const TTL_MS = 5 * 60_000;

/** Agents ccusage knows how to read. Anything else short-circuits without a
 *  spawn — Cursor is the live case, and asking would cost 0.5s to learn null. */
const SUPPORTED = new Set([
  "claude",
  "codex",
  "opencode",
  "amp",
  "droid",
  "codebuff",
  "hermes",
  "pi",
  "goose",
  "kilo",
  "copilot",
  "gemini",
  "kimi",
  "qwen",
  "openclaw",
]);

let binCache = { at: 0, value: null };
const memo = new Map(); // key → { at, promise }

/**
 * Locate the binary. The app bundles one next to the compiled bridge
 * (Resources/bridge/ccusage), which is the path that makes this work for a
 * normal install; the rest let a developer or a user-managed copy win.
 *
 * Order matters: a user's pinned override beats ours, and ours beats PATH only
 * because the bundled build is version-matched to this contract.
 */
export function findCcusage() {
  // Re-resolve periodically so an install that lands after startup is picked up,
  // and so a deleted binary stops being reported as present.
  if (binCache.value && Date.now() - binCache.at < TTL_MS) return binCache.value;
  const pinned = binOverride("ccusage");
  const candidates = [
    pinned,
    process.env.POUNCE_CCUSAGE_BIN,
    // Sibling of the running executable: the bun-compiled bridge lives at
    // …/Resources/bridge/pounce-bridge, so the bundled ccusage is right there.
    path.join(path.dirname(process.execPath), EXE),
    path.join(os.homedir(), ".pounce", "bin", EXE),
  ].filter(Boolean);
  let found = candidates.find((p) => existsSync(p)) || null;
  if (!found) {
    for (const dir of (agentEnv().PATH || "").split(path.delimiter)) {
      if (dir && existsSync(path.join(dir, EXE))) {
        found = path.join(dir, EXE);
        break;
      }
    }
  }
  binCache = { at: Date.now(), value: found };
  return found;
}

/** Whether an estimate is obtainable at all — the app uses this to decide
 *  whether "no dollar figure" is worth explaining. */
export function ccusageAvailable() {
  return findCcusage() != null;
}

/** Run ccusage and parse its JSON. Resolves null on ANY failure (missing
 *  binary, nonzero exit, timeout, unparseable output) — an estimate is a
 *  nice-to-have and must never surface as a dashboard error. */
function ccusageJson(args) {
  const bin = findCcusage();
  if (!bin) return Promise.resolve(null);
  return new Promise((resolve) => {
    let p;
    try {
      p = spawn(bin, args, {
        env: agentEnv(),
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch {
      return resolve(null);
    }
    let out = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try {
        p.kill("SIGKILL");
      } catch {}
    }, TIMEOUT_MS);
    p.stdout.on("data", (d) => (out += d));
    p.on("close", (code) => {
      clearTimeout(timer);
      if (killed || code !== 0) return resolve(null);
      try {
        resolve(JSON.parse(out));
      } catch {
        resolve(null);
      }
    });
    p.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

/** Share one in-flight run per key for TTL_MS. Failures are cached too, briefly,
 *  so a machine without the binary doesn't respawn on every request. */
function cached(key, fn) {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.promise;
  const promise = fn();
  memo.set(key, { at: Date.now(), promise });
  return promise;
}

/**
 * A row's dollars, or null when the number isn't trustworthy.
 *
 * `cost > 0` is the only case we accept. Zero with tokens behind it means
 * pricing didn't resolve (see trap 2 in the header); zero with no tokens is an
 * empty row worth nothing either way.
 */
function costOf(row) {
  const cost = row?.totalCost;
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost <= 0) return null;
  return cost;
}

/**
 * Read one thread's estimate out of a `session --id` payload.
 *
 * `--id` returns a DIFFERENT shape to the list form — `{ sessionId, totalCost,
 * totalTokens, entries[] }` rather than `{ session: [...] }` — and it refuses
 * `--by-agent`, so the row carries no agent field to check against. The id is
 * verified instead; that's what stops a stale or mismatched payload from being
 * attributed to the wrong thread.
 *
 * Do NOT sum `entries[].costUSD`: that column is what the AGENT recorded, which
 * for Claude is 0 on every line (it writes no cost to its transcript — the whole
 * reason ./cost-ledger.mjs exists). Summing it yields a confident $0.00 for a
 * thread the top-level `totalCost` prices at several dollars.
 */
export function parseSession(json, threadId) {
  if (!json || json.sessionId !== threadId) return null;
  const cost = costOf(json);
  if (cost == null) return null;
  const models = [...new Set((json.entries ?? []).map((e) => e?.model).filter(Boolean))];
  return { cost, models };
}

/**
 * Reshape a `daily --by-agent` payload into `{ "YYYY-MM-DD": { total, byAgent } }`.
 *
 * Days ccusage priced at zero are omitted entirely rather than recorded as 0 —
 * the caller distinguishes "no estimate" from "free", and an absent key is how
 * this says the former.
 */
export function parseDaily(json) {
  const byDay = {};
  for (const row of json?.daily ?? []) {
    const date = typeof row?.period === "string" ? row.period.slice(0, 10) : null;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const total = costOf(row);
    if (total == null) continue;
    const byAgent = {};
    for (const a of row.agents ?? []) {
      const c = costOf(a);
      if (c != null && a?.agent) byAgent[a.agent] = c;
    }
    byDay[date] = { total, byAgent };
  }
  return byDay;
}

/**
 * Estimated cost for one thread, or null when ccusage has nothing to say about
 * it.
 */
export function threadCost(agent, threadId) {
  // The agent gate is what keeps Cursor (which ccusage cannot read) from paying
  // half a second to be told null — `--id` itself searches every agent's store.
  if (!threadId || !SUPPORTED.has(agent)) return Promise.resolve(null);
  return cached(`t:${threadId}`, async () => {
    const json = await ccusageJson(["session", "--json", "--no-color", "-i", threadId]);
    return parseSession(json, threadId);
  });
}

/**
 * Estimated dollars per day for the last `days`, as
 * `{ available, byDay: { "YYYY-MM-DD": { total, byAgent } } }`.
 *
 * `available: false` means we couldn't ask at all (no binary, or the run
 * failed) — distinct from asking and being told nothing, which is an empty
 * `byDay` on an available report.
 */
export function dailyCost({ days = 30, now = new Date() } = {}) {
  const since = new Date(now.getTime() - (days - 1) * 24 * 60 * 60_000).toISOString().slice(0, 10);
  return cached(`d:${since}`, async () => {
    const json = await ccusageJson([
      "daily",
      "--json",
      "--no-color",
      "--by-agent",
      "--since",
      since.replace(/-/g, ""),
    ]);
    if (!json) return { available: false, byDay: {} };
    return { available: true, byDay: parseDaily(json) };
  });
}

/** Drop every memo — used when a refresh must actually re-read the transcripts. */
export function resetCcusageCache() {
  memo.clear();
  binCache = { at: 0, value: null };
}
