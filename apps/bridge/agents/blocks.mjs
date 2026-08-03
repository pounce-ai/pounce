/**
 * Rolling usage blocks — the shape of a subscription limit, measured from the
 * agent's own transcripts.
 *
 * Claude bills a Max/Pro seat against rolling windows: one opens at your first
 * message and runs five hours, and a second runs a week. Anthropic sends the
 * remaining allowance in API response headers and writes none of it to disk
 * (see quota.mjs), so the window's SIZE is not knowable locally.
 *
 * What IS knowable is everything else about it: when the current window opened,
 * how much has gone into it, how fast, and when it rolls over. That's what this
 * computes — and deliberately nothing more.
 *
 * On the percentage this stops short of: every tool that shows one infers the
 * ceiling from your own busiest historical window. That's a guess dressed as a
 * gauge, and it fails in the exact case a user most wants it — someone who has
 * never been throttled has no maximum to infer from, so the bar reads past 100%
 * and calls it a limit. This reports `peak`, labelled as the highest window on
 * record, and lets the reader do the comparison a percentage would have faked.
 *
 * Costs one tail read per recently-touched thread; the big cached day index in
 * activity-index.mjs is untouched, because blocks only ever look at the last
 * few days.
 */
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Claude Code's transcript root: ~/.claude/projects/<slug>/<session>.jsonl. */
const CLAUDE_ROOT = path.join(os.homedir(), ".claude", "projects");

/** Claude's session window. Not a wall-clock boundary: it opens at the first
 *  message and runs from there, which is why blocks are derived from data
 *  rather than bucketed by hour. */
export const BLOCK_HOURS = 5;
const HOUR_MS = 3_600_000;

/** Claude Code's marker for a turn it wrote itself — no API call, no usage. */
const SYNTHETIC_MODEL = "<synthetic>";

/**
 * How much of each transcript's END to read.
 *
 * Transcripts are append-only, so recent turns are always at the tail — but
 * they run past 100MB, and reading whole files made a 30-day scan cost ~950ms.
 * 24MB is far more than a five-hour window can produce while still covering
 * weeks of ordinary use; anything older isn't what this measures.
 * (`quota.mjs` reads Codex rollouts the same way, for the same reason.)
 */
const TAIL_BYTES = 24 * 1024 * 1024;

/** Read `{ts, tokens}` samples out of a Claude transcript's tail.
 *  Only lines at or after `sinceMs` matter, but JSONL has no index, so the file
 *  is streamed — cheaply, since callers pre-filter by mtime. */
async function claudeSamples(file, sinceMs, out) {
  let start = 0;
  try {
    const { size } = statSync(file);
    // Start mid-file on a big transcript. The first line read is then usually a
    // fragment, which fails JSON.parse and is skipped — the cost of not seeking
    // to a line boundary we have no index for.
    if (size > TAIL_BYTES) start = size - TAIL_BYTES;
  } catch {
    return;
  }
  let buf = null;
  for await (const chunk of createReadStream(file, { start })) {
    buf = buf && buf.length ? Buffer.concat([buf, chunk]) : chunk;
    let idx;
    while ((idx = buf.indexOf(0x0a)) !== -1) {
      const line = buf.subarray(0, idx).toString("utf8");
      buf = buf.subarray(idx + 1);
      if (!line.trim()) continue;
      // Cheap reject before JSON.parse — most lines are user turns and tool
      // results, and parsing every one of a 40MB transcript is the whole cost.
      if (!line.includes('"assistant"') || !line.includes('"usage"')) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o.type !== "assistant") continue;
      const u = o.message?.usage;
      if (!u || o.message.model === SYNTHETIC_MODEL) continue;
      const ms = Date.parse(o.timestamp ?? "");
      if (!Number.isFinite(ms) || ms < sinceMs) continue;
      out.push({
        ms,
        tokens:
          (u.input_tokens || 0) +
          (u.output_tokens || 0) +
          (u.cache_read_input_tokens || 0) +
          (u.cache_creation_input_tokens || 0),
      });
    }
  }
}

/**
 * Fold time-ordered samples into rolling windows: the first sample opens a
 * block, everything within `BLOCK_HOURS` of that opening joins it, and the
 * first sample past the edge opens the next one.
 */
export function foldBlocks(samples, blockMs = BLOCK_HOURS * HOUR_MS) {
  const sorted = [...samples].sort((a, b) => a.ms - b.ms);
  const blocks = [];
  for (const s of sorted) {
    const cur = blocks[blocks.length - 1];
    if (!cur || s.ms >= cur.startedMs + blockMs) {
      blocks.push({ startedMs: s.ms, lastMs: s.ms, tokens: s.tokens, messages: 1 });
    } else {
      cur.lastMs = s.ms;
      cur.tokens += s.tokens;
      cur.messages += 1;
    }
  }
  return blocks;
}

const iso = (ms) => new Date(ms).toISOString();

/** Transcript files touched since `sinceMs`. A file untouched since the window
 *  opened cannot hold a sample inside it, so it's never read. */
function recentTranscripts(sinceMs) {
  const out = [];
  let projects;
  try {
    projects = readdirSync(CLAUDE_ROOT, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const dir = path.join(CLAUDE_ROOT, p.name);
    let files;
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const full = path.join(dir, f);
      try {
        if (statSync(full).mtimeMs >= sinceMs) out.push(full);
      } catch {
        // Rotated away mid-scan — skip.
      }
    }
  }
  return out;
}

/**
 * Current window, burn rate and the peak on record for one agent.
 *
 * Only Claude carries per-message usage in its transcripts, so any other agent
 * returns null rather than a fabricated shape.
 */
// 7 days, not 30: the current window is the live number and has to be cheap to
// refresh, while a month of history costs ~10x the scan for context that barely
// moves. A week also matches the weekly limit these plans actually meter.
export async function readBlocks({ agent = "claude", days = 7, now = Date.now() } = {}) {
  if (agent !== "claude") return null;
  const sinceMs = now - days * 24 * HOUR_MS;
  // Straight off disk rather than from the host's thread list: that list is a
  // client payload and drops `filePath` (a local path is nobody's business over
  // the wire), and this way blocks don't wait on the thread cache either.
  const files = recentTranscripts(sinceMs);

  const samples = [];
  await Promise.all(
    files.map(async (f) => {
      if (!existsSync(f)) return;
      await claudeSamples(f, sinceMs, samples).catch(() => {});
    }),
  );
  if (!samples.length) return null;

  const blockMs = BLOCK_HOURS * HOUR_MS;
  const blocks = foldBlocks(samples, blockMs);
  const peak = blocks.reduce((m, b) => (b.tokens > m.tokens ? b : m), blocks[0]);
  const last = blocks[blocks.length - 1];
  // "Current" only if the newest block's window hasn't already rolled over.
  const active = now < last.startedMs + blockMs ? last : null;

  // Burn measured across the elapsed part of the window, floored at a minute so
  // a single message at second zero doesn't read as an astronomical rate.
  const elapsedMin = active ? Math.max(1, (now - active.startedMs) / 60_000) : 0;

  const weekAgo = now - 7 * 24 * HOUR_MS;
  const weekly = samples.reduce((n, s) => (s.ms >= weekAgo ? n + s.tokens : n), 0);

  return {
    agent,
    windowHours: BLOCK_HOURS,
    current: active
      ? {
          startedAt: iso(active.startedMs),
          resetsAt: iso(active.startedMs + blockMs),
          tokens: active.tokens,
          messages: active.messages,
          tokensPerMin: Math.round(active.tokens / elapsedMin),
        }
      : null,
    /** Busiest window WITHIN `scannedDays` — context for the current one, not a
     *  limit and not an all-time high. The UI must say which range it covers:
     *  the tail read below means older history genuinely isn't in view. */
    peak: { tokens: peak.tokens, startedAt: iso(peak.startedMs) },
    weeklyTokens: weekly,
    scannedDays: days,
  };
}
