/**
 * Daily activity series — what the app's Activity dashboard charts.
 *
 * Two sources, deliberately kept apart because they answer different questions:
 *
 *   TOKENS / MESSAGES  scanned per DAY out of the agents' own transcripts
 *                      (Claude's `message.usage` lines, Codex's `token_count`
 *                      rollout events). These are the agent's own numbers with
 *                      a date attached — no arithmetic beyond summing them.
 *
 *   DOLLARS            read from the cost ledger only (~/.pounce/usage.jsonl),
 *                      i.e. figures an agent actually reported. This module
 *                      NEVER multiplies tokens by a rate; see ./usage.mjs for
 *                      why the old price table was deleted. A day with real
 *                      work but no reported cost carries `cost: null`, which
 *                      the UI renders as "not knowable" rather than "$0".
 *
 * Consequence worth knowing: Claude only reports USD on the envelope that
 * closes a turn the BRIDGE drove, so a history of terminal-driven turns has
 * complete tokens and almost no dollars. That asymmetry is the honest state of
 * the data, and `coverage` reports it per agent so the dashboard can say so.
 *
 * Transcripts are large and append-only, so per-thread day maps are cached on
 * disk keyed by the file's mtime+size and resumed from a byte offset when a
 * file has only grown — a cold first scan is the slow path, everything after is
 * a stat() per thread.
 */
import { createReadStream, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LEDGER_FILE } from "./cost-ledger.mjs";

/** Agents whose transcripts carry per-turn token counts we can date. */
const TOKEN_AGENTS = new Set(["claude", "codex"]);

/** Claude Code's marker for a turn it wrote itself — no API call, no usage. */
const SYNTHETIC_MODEL = "<synthetic>";

const CACHE_VERSION = 1;
const MAX_DAYS = 400;
const PARSE_CONCURRENCY = 4;

function dayOf(ts) {
  if (typeof ts !== "string" || ts.length < 10) return null;
  const d = ts.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

const round = (n, p = 4) => Math.round(n * 10 ** p) / 10 ** p;

/**
 * Stream a file's complete lines from `start`, returning the offset through the
 * LAST NEWLINE. A trailing partial line (a transcript caught mid-write) is left
 * unconsumed so the next pass re-reads it whole — this is what makes resuming
 * from a byte offset safe.
 */
async function forEachLine(file, start, onLine) {
  let consumed = start;
  let buf = null;
  for await (const chunk of createReadStream(file, { start })) {
    buf = buf && buf.length ? Buffer.concat([buf, chunk]) : chunk;
    let idx;
    while ((idx = buf.indexOf(0x0a)) !== -1) {
      const line = buf.subarray(0, idx).toString("utf8").trim();
      buf = buf.subarray(idx + 1);
      consumed += idx + 1;
      if (line) onLine(line);
    }
  }
  return consumed;
}

const emptyAcc = () => ({ byDay: {} });

function bump(acc, day, tokens, messages = 1) {
  if (!day) return;
  acc.byDay[day] ??= { tokens: 0, messages: 0 };
  acc.byDay[day].tokens += tokens;
  acc.byDay[day].messages += messages;
}

/** Claude Code: one assistant line per API call, `message.usage` inline. */
function parseClaudeLine(acc, line) {
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return;
  }
  if (o.type !== "assistant") return;
  const u = o.message?.usage;
  if (!u || o.message.model === SYNTHETIC_MODEL) return;
  const total =
    (u.input_tokens || 0) +
    (u.output_tokens || 0) +
    (u.cache_read_input_tokens || 0) +
    (u.cache_creation_input_tokens || 0);
  bump(acc, dayOf(o.timestamp), total);
}

/**
 * Codex: `token_count` events carry `last_token_usage`, the delta for the call
 * just made. (`total_token_usage` is cumulative but gets rebased when a session
 * compacts, so summing the deltas is the figure that matches what ran.)
 */
function parseCodexLine(acc, line) {
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return;
  }
  const p = o.payload;
  if (!p || o.type !== "event_msg" || p.type !== "token_count") return;
  const u = p.info?.last_token_usage;
  if (!u) return;
  bump(acc, dayOf(o.timestamp), u.total_tokens || 0);
}

const PARSERS = { claude: parseClaudeLine, codex: parseCodexLine };

function trimDays(byDay) {
  const keys = Object.keys(byDay);
  if (keys.length <= MAX_DAYS) return byDay;
  keys.sort();
  for (const k of keys.slice(0, keys.length - MAX_DAYS)) delete byDay[k];
  return byDay;
}

/** UTC `YYYY-MM-DD`, n days back — the window bound for the series. */
export function isoDaysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

export function createActivityIndex({
  resolveFile,
  cacheFile = path.join(os.homedir(), ".pounce", "activity-cache.json"),
  ledgerFile = LEDGER_FILE,
} = {}) {
  /** key `agent:threadId` → { file, mtimeMs, size, parsedBytes, byDay } */
  const entries = new Map();
  const inflight = new Map();
  let loaded = false;
  let dirty = false;
  let flushTimer = null;
  let active = 0;
  const queue = [];

  async function load() {
    if (loaded) return;
    loaded = true;
    try {
      const raw = JSON.parse(await readFile(cacheFile, "utf8"));
      if (raw?.version === CACHE_VERSION && raw.threads) {
        for (const [k, v] of Object.entries(raw.threads)) entries.set(k, v);
      }
    } catch {
      // No cache yet, or a stale version — rebuild from the transcripts.
    }
  }

  function scheduleFlush() {
    dirty = true;
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush();
    }, 3000);
    flushTimer.unref?.();
  }

  /** Write-through, atomically — a torn file would just be re-parsed, but a
   *  rename keeps a concurrent reader from ever seeing one. */
  function flush() {
    if (!dirty) return;
    dirty = false;
    try {
      mkdirSync(path.dirname(cacheFile), { recursive: true });
      const tmp = `${cacheFile}.tmp`;
      writeFileSync(
        tmp,
        JSON.stringify({ version: CACHE_VERSION, threads: Object.fromEntries(entries) }),
      );
      renameSync(tmp, cacheFile);
    } catch {
      // A read-only home shouldn't break the dashboard — memory still works.
    }
  }

  /** Cap concurrent parses: a cold scan of hundreds of threads would otherwise
   *  open every transcript at once and stall the bridge. */
  function withSlot(fn) {
    if (active < PARSE_CONCURRENCY) {
      active++;
      return fn().finally(() => {
        active--;
        queue.shift()?.();
      });
    }
    return new Promise((resolve, reject) => {
      queue.push(() => {
        active++;
        fn()
          .then(resolve, reject)
          .finally(() => {
            active--;
            queue.shift()?.();
          });
      });
    });
  }

  async function parse(agent, key, file, st) {
    const prev = entries.get(key);
    const resume =
      prev && prev.file === file && prev.parsedBytes > 0 && st.size >= prev.parsedBytes
        ? prev
        : null;
    const acc = emptyAcc();
    if (resume) {
      for (const [d, v] of Object.entries(resume.byDay || {})) {
        acc.byDay[d] = { tokens: v.tokens || 0, messages: v.messages || 0 };
      }
    }
    const onLine = PARSERS[agent];
    const parsedBytes = await forEachLine(file, resume ? resume.parsedBytes : 0, (line) =>
      onLine(acc, line),
    );
    const entry = {
      file,
      mtimeMs: st.mtimeMs,
      size: st.size,
      parsedBytes,
      byDay: trimDays(acc.byDay),
    };
    entries.set(key, entry);
    scheduleFlush();
    return entry.byDay;
  }

  /** Per-day `{tokens, messages}` for one thread. `{}` when it has no usable
   *  records (Cursor/Opencode keep no dated token counts we can read). */
  async function threadDays(agent, threadId) {
    if (!TOKEN_AGENTS.has(agent)) return {};
    await load();
    const key = `${agent}:${threadId}`;
    const file = await resolveFile(agent, threadId).catch(() => null);
    if (!file) return {};
    let st;
    try {
      st = statSync(file);
    } catch {
      return {};
    }
    const prev = entries.get(key);
    if (prev && prev.file === file && prev.mtimeMs === st.mtimeMs && prev.size === st.size) {
      return prev.byDay;
    }
    if (inflight.has(key)) return inflight.get(key);
    const p = withSlot(() => parse(agent, key, file, st))
      .catch(() => ({}))
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  /** Official per-day dollars from the ledger, keyed by agent. Absent agents
   *  simply contribute nothing — never a synthesized zero. */
  async function ledgerDays(since) {
    const out = new Map(); // date -> { total, byAgent: Map }
    let text;
    try {
      text = await readFile(ledgerFile, "utf8");
    } catch {
      return out;
    }
    for (const line of text.split("\n")) {
      if (!line) continue;
      let r;
      try {
        r = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof r?.costUsd !== "number") continue;
      const day = dayOf(r.ts);
      if (!day || (since && day < since)) continue;
      if (!out.has(day)) out.set(day, { total: 0, byAgent: new Map() });
      const d = out.get(day);
      d.total += r.costUsd;
      d.byAgent.set(r.agent, (d.byAgent.get(r.agent) || 0) + r.costUsd);
    }
    return out;
  }

  /**
   * The dashboard series. Sessions come from thread metadata (so an agent whose
   * tokens we can't read still counts as activity), tokens/messages from the
   * transcript scan, dollars from the ledger.
   */
  async function series(threads, { days = 365 } = {}) {
    const since = days > 0 ? isoDaysAgo(days - 1) : null;
    const byDate = new Map();
    const day = (date) => {
      if (!byDate.has(date)) {
        byDate.set(date, { date, sessions: 0, messages: 0, tokens: 0, cost: null, byAgent: {} });
      }
      return byDate.get(date);
    };
    const agentOn = (d, agent) => {
      d.byAgent[agent] ??= { sessions: 0, messages: 0, tokens: 0, cost: null };
      return d.byAgent[agent];
    };
    const totals = { sessions: 0, messages: 0, tokens: 0, cost: null, costComplete: true };
    const coverage = {};

    // Read every thread's day map CONCURRENTLY. Awaiting inside the fold below
    // would serialize them and defeat withSlot's own PARSE_CONCURRENCY limit —
    // `active` could never exceed 1 — which is what made the first (cold) call
    // of the day take tens of seconds.
    const perDays = await Promise.all(threads.map((t) => threadDays(t.agent, t.id)));

    for (const [i, t] of threads.entries()) {
      coverage[t.agent] ??= TOKEN_AGENTS.has(t.agent) ? "tokens" : "sessions-only";
      const started = dayOf(t.createdAt);
      if (started && (!since || started >= since)) {
        const d = day(started);
        d.sessions++;
        agentOn(d, t.agent).sessions++;
        totals.sessions++;
      }
      for (const [date, v] of Object.entries(perDays[i])) {
        if (since && date < since) continue;
        const d = day(date);
        d.messages += v.messages;
        d.tokens += v.tokens;
        const a = agentOn(d, t.agent);
        a.messages += v.messages;
        a.tokens += v.tokens;
        totals.messages += v.messages;
        totals.tokens += v.tokens;
      }
    }

    // Dollars last, so a day that only has cost (a turn whose transcript we
    // can't read) still shows up rather than being silently dropped.
    const ledger = await ledgerDays(since);
    for (const [date, v] of ledger) {
      const d = day(date);
      d.cost = round((d.cost ?? 0) + v.total);
      for (const [agent, c] of v.byAgent) {
        const a = agentOn(d, agent);
        a.cost = round((a.cost ?? 0) + c);
        coverage[agent] = "full";
      }
      totals.cost = round((totals.cost ?? 0) + v.total, 2);
    }
    // Any agent that did real work without reporting a dollar for it leaves the
    // total partial — the UI marks the number rather than implying completeness.
    if (Object.values(coverage).some((c) => c !== "full")) totals.costComplete = false;

    return {
      days: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
      totals,
      coverage,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Warm every thread's day map without building a series — the background
   * populate pass. Returns how many threads it actually had to read.
   */
  async function populate(threads) {
    // Concurrent for the same reason as series(): withSlot already provides the
    // backpressure the sequential loop was standing in for, and this runs on a
    // timer whose whole point is to stay off the critical path.
    const wanted = threads.filter((t) => TOKEN_AGENTS.has(t.agent));
    const before = wanted.map((t) => entries.get(`${t.agent}:${t.id}`));
    await Promise.all(wanted.map((t) => threadDays(t.agent, t.id)));
    const scanned = wanted.reduce(
      (n, t, i) => n + (entries.get(`${t.agent}:${t.id}`) !== before[i] ? 1 : 0),
      0,
    );
    flush();
    return scanned;
  }

  return {
    series,
    populate,
    threadDays,
    flush,
    invalidate(agent, threadId) {
      entries.delete(`${agent}:${threadId}`);
      scheduleFlush();
    },
  };
}
