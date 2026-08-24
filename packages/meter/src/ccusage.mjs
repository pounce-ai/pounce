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
import { chmodSync, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { spawn } from "node:child_process";
import { agentEnv, binOverride } from "./host.mjs";

const EXE = process.platform === "win32" ? "ccusage.exe" : "ccusage";
const POUNCE_BIN = path.join(os.homedir(), ".pounce", "bin");

/**
 * Pinned ccusage, auto-installed into ~/.pounce/bin when none is found — the
 * same drop location as ctx and pounce-tunnel.
 *
 * v20 has no GitHub release assets: it ships as one npm package per platform
 * carrying a single native executable at `package/bin/ccusage`. We fetch that
 * tarball straight from the registry rather than running a package manager, so
 * a bridge with no Node toolchain around it can still install.
 *
 * `integrity` is npm's own sha512 for the tarball, copied from the registry
 * metadata. Bump the version and ALL six hashes together.
 */
const CCUSAGE_VERSION = "20.0.19";
const CCUSAGE_ASSETS = {
  "darwin-arm64":
    "sha512-8b69h4tuMH1KNW+EYjFRJWpbWHXbMUtFu8cOCyFOQsR6lGxq37g0kzEGHSqG+iZEoUTHaabR5CE7ZHLhW9Q64A==",
  "darwin-x64":
    "sha512-YTsqIfsPo3qR9OMrwJtnJoq/fil7Jk5mzXV8k0Iejpiq7zysw4FfkjCeHr0UVJG8ihdqtE18o+xIk99p3v+5Ew==",
  "linux-x64":
    "sha512-VPbB6onrwOGojTKutFzeahttb98ZgmdsiQpOr/BJet1i3QdrmUGXGmJSt591xXrvVOVVgsC7/5wBELdWM9/bKA==",
  "linux-arm64":
    "sha512-4e+7hV3WrEpM7hQPQkh4/zNLTUSqzpd+vSSWl2y659+xQ+JCDLWqE6gzvXLMOAT/LTtcFtlrduIWDZt8VPceqQ==",
  "win32-x64":
    "sha512-KtDlTk07uv8cu6TlizB/RptcDiQePE1YSQe6uNNZTUnwVy9zq5R3fvUUFr9/d3FYHwimSGduoHXRS8Ta+Kmkrw==",
  "win32-arm64":
    "sha512-oOv4mZkapxzvQeAMI+jqfTOv/zN2x2AYPAD+F4AnYHQQL4n898axhH9uPd2Ls0U5CDlvfh1zDTyNILz8X9M15A==",
};

const INSTALL_TIMEOUT_MS = 120_000;

/**
 * Pull one member out of an uncompressed tar.
 *
 * A hand-rolled reader rather than the `tar` CLI: Windows only gained a bundled
 * tar.exe in Win10 1803, and the format needed here is the simple half of it —
 * 512-byte header blocks, NUL-padded name at 0, octal size at 124, file body
 * rounded up to the next 512 boundary.
 */
function tarExtract(buf, member) {
  for (let off = 0; off + 512 <= buf.length;) {
    const name = buf.toString("utf8", off, off + 100).replace(/\0.*$/, "");
    if (!name) break; // two NUL blocks mark the end of the archive
    const size = parseInt(
      buf
        .toString("ascii", off + 124, off + 136)
        .replace(/\0.*$/, "")
        .trim(),
      8,
    );
    if (!Number.isFinite(size)) break;
    const body = off + 512;
    if (name === member) return buf.subarray(body, body + size);
    off = body + Math.ceil(size / 512) * 512;
  }
  return null;
}

/**
 * Download the pinned ccusage for this platform into ~/.pounce/bin.
 *
 * Refuses to keep anything whose sha512 doesn't match npm's own integrity
 * string. Returns the installed path, or null (unsupported platform, network
 * failure, or a tarball that didn't contain the executable).
 */
async function downloadCcusage(log) {
  const integrity = CCUSAGE_ASSETS[`${process.platform}-${process.arch}`];
  if (!integrity) return null;
  const pkg = `ccusage-${process.platform}-${process.arch}`;
  const url = `https://registry.npmjs.org/@ccusage/${pkg}/-/${pkg}-${CCUSAGE_VERSION}.tgz`;
  log(`downloading ccusage ${CCUSAGE_VERSION} (${pkg})…`);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), INSTALL_TIMEOUT_MS);
  const dest = path.join(POUNCE_BIN, EXE);
  const tmp = `${dest}.download`;
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const digest = `sha512-${createHash("sha512").update(buf).digest("base64")}`;
    if (digest !== integrity) throw new Error(`checksum mismatch for ${pkg}`);
    const bin = tarExtract(gunzipSync(buf), "package/bin/ccusage");
    if (!bin?.length) throw new Error("tarball has no package/bin/ccusage");
    mkdirSync(POUNCE_BIN, { recursive: true });
    writeFileSync(tmp, bin);
    chmodSync(tmp, 0o755);
    renameSync(tmp, dest);
    log(`ccusage installed at ${dest}`);
    binCache = { at: 0, value: null };
    return dest;
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {}
    log(`ccusage install failed: ${e?.message || e}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

let installing = null;

/**
 * Ensure a ccusage exists, installing the pinned build if not.
 *
 * At most one install runs at a time and a failure is not retried on every
 * request — `installing` keeps the promise so a machine that is offline (or on
 * an unsupported platform) settles into "no binary" rather than re-downloading.
 */
export function ensureCcusage(log = () => {}) {
  const found = findCcusage();
  if (found) return Promise.resolve(found);
  installing ??= downloadCcusage(log);
  return installing;
}

/** A full-history `daily` pass measured ~2s over a year of transcripts; a single
 *  `session` lookup ~0.5s. The ceiling is for a cold machine with far more. */
const TIMEOUT_MS = 30_000;

/** Same memo window as the billing report: this is a dashboard, and re-scanning
 *  every transcript on each pull-to-refresh would be gratuitous. */
const TTL_MS = 5 * 60_000;

/** Agents ccusage knows how to read. Anything else short-circuits without a
 *  spawn — Cursor is the live case, and asking would cost 0.5s to learn null. */
export const SUPPORTED = new Set([
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
 * The five token columns off any ccusage row (daily, per-agent, or per-model).
 *
 * `tokens` is the REPORTED TOTAL — `totalTokens`, exactly as ccusage read it out
 * of the agent's own records. No arithmetic of ours sits on top of it.
 *
 * That's deliberate, and it's a reversal. An earlier version made the headline
 * `total - cacheRead`, on the reasoning that re-read context isn't new work.
 * It isn't — but subtracting it invented a figure no other tool reports, so the
 * dashboard then disagreed with the lifetime total on the agent's own profile
 * page and had to explain itself. Matching the source beats explaining a
 * difference. `cacheRead` rides alongside so the UI can show the split as a
 * subscript rather than a subtraction.
 *
 * The columns are still worth normalizing, because the agents disagree
 * underneath: Anthropic reports `cache_read_input_tokens` as a field SEPARATE
 * from `input_tokens`, while OpenAI reports `cached_input_tokens` as a SUBSET of
 * it. ccusage reconciles both into one shape whose four columns sum to
 * `totalTokens` with nothing double-counted (verified: for a Codex session whose
 * raw file has input 126,414,563 including 116,586,880 cached, it reports
 * inputTokens 9,491,457 with the cached amount moved into cacheReadTokens).
 * Absorbing that per-agent divergence is what we get from the package.
 */
function tokensOf(row) {
  const n = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  const total = n(row?.totalTokens);
  const cacheRead = n(row?.cacheReadTokens);
  return {
    // The REPORTED TOTAL, with no arithmetic of ours on top — see above.
    tokens: total,
    input: n(row?.inputTokens),
    output: n(row?.outputTokens),
    cacheCreate: n(row?.cacheCreationTokens),
    cacheRead,
    total,
    cost: costOf(row),
  };
}

/**
 * Reshape `daily --by-agent` into the breakdown the Tokens card drills into:
 * a day, the agents that ran that day, and the models each of them used.
 *
 * Unlike ./parseDaily (cost only, and silent on days it couldn't price), this
 * keeps every day that has tokens — an unpriced day is still a real day of
 * work, and `cost: null` says the dollars are unknown without hiding it.
 */
export function parseDailyUsage(json) {
  const byDay = {};
  for (const row of json?.daily ?? []) {
    const date = typeof row?.period === "string" ? row.period.slice(0, 10) : null;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const day = tokensOf(row);
    if (!day.total) continue;
    day.agents = (row.agents ?? [])
      .filter((a) => a?.agent)
      .map((a) => ({
        agent: a.agent,
        ...tokensOf(a),
        models: (a.modelBreakdowns ?? [])
          .filter((m) => m?.modelName)
          // A model row spells `cost`, not `totalCost`, and carries no total of
          // its own — so normalize both before tokensOf sees it.
          .map((m) => ({
            model: m.modelName,
            ...tokensOf({
              ...m,
              totalCost: m.cost,
              totalTokens:
                (m.inputTokens || 0) +
                (m.outputTokens || 0) +
                (m.cacheCreationTokens || 0) +
                (m.cacheReadTokens || 0),
            }),
          }))
          .sort((x, y) => y.tokens - x.tokens),
      }))
      .sort((x, y) => y.tokens - x.tokens);
    byDay[date] = day;
  }
  return byDay;
}

/**
 * Token usage per day for a window, as `{ available, byDay }`.
 *
 * `available: false` means we could not ask — no binary and no install. The
 * dashboard needs that distinction: unlike cost, a missing token figure is not
 * a nice-to-have that can quietly read zero.
 */
/**
 * ONE `daily --by-agent` run for a window, shared by every reader of it.
 *
 * Tokens and dollars come out of the same payload, so this is memoized on the
 * window rather than on the caller: the two used to build byte-identical argv
 * under different memo keys and each pay for a full-history transcript scan
 * (~2s, more on a cold machine), serially, on the same request.
 *
 * An absent binary starts an install but never WAITS on it. The download has a
 * 120s ceiling and this sits on /v1/activity, so blocking would hang the
 * dashboard's first load for up to two minutes to obtain a figure that is
 * optional. The caller reports "unavailable" for this cycle and picks ccusage
 * up on the next one; ensureCcusage keeps its own single-flight promise, so
 * the fire-and-forget can't stack up.
 */
function dailyPayload(from, until) {
  const args = ["daily", "--json", "--no-color", "--by-agent", "--since", from.replace(/-/g, "")];
  if (until) args.push("--until", until.replace(/-/g, ""));
  return cached(`daily:${from}:${until || ""}`, async () => {
    if (!findCcusage()) {
      ensureCcusage((m) => console.log(`[ccusage] ${m}`)).catch(() => {});
      return null;
    }
    return ccusageJson(args);
  });
}

export function dailyUsage({ since, until, now = new Date() } = {}) {
  const from = since || new Date(now.getTime() - 364 * 24 * 60 * 60_000).toISOString().slice(0, 10);
  return dailyPayload(from, until).then((json) =>
    json ? { available: true, byDay: parseDailyUsage(json) } : { available: false, byDay: {} },
  );
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
export function dailyCost({ days = 30, since, now = new Date() } = {}) {
  // `since` lets the caller pin the SAME window the token read used, so both
  // land on one memo entry and one spawn. Without it a call that straddles
  // midnight would compute a different date and pay for a second full scan.
  const from =
    since || new Date(now.getTime() - (days - 1) * 24 * 60 * 60_000).toISOString().slice(0, 10);
  return dailyPayload(from, null).then((json) =>
    json ? { available: true, byDay: parseDaily(json) } : { available: false, byDay: {} },
  );
}

/** Drop every memo — used when a refresh must actually re-read the transcripts. */
export function resetCcusageCache() {
  memo.clear();
  binCache = { at: 0, value: null };
}
