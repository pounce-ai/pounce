/**
 * Claude Code's transcript store, and how to read it.
 *
 * Where the files live, which of them a window could possibly touch, and how
 * much of each to read — facts about Claude Code rather than about any one
 * report, so they belong in one place. `blocks.mjs` (rolling-window totals) and
 * `attribution.mjs` (what filled a window) both read the SAME files and had
 * grown their own copies of all of it.
 *
 * That duplication was not harmless: the two copies disagreed about the tail
 * bound. `attribution.mjs` measured that 24MB leaves 36.6% of a 7-day window
 * unread and scaled its own limit accordingly, while `blocks.mjs` — which also
 * defaults to 7 days — kept the flat 24MB and went on quietly under-reading.
 * One bound in one file is what stops that happening again.
 */
import { createReadStream, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** ~/.claude/projects/<slug>/<session>.jsonl */
export const CLAUDE_ROOT = path.join(os.homedir(), ".claude", "projects");

export const HOUR_MS = 3_600_000;

/** Claude Code's marker for a turn it wrote itself — no API call, no usage. */
export const SYNTHETIC_MODEL = "<synthetic>";

/**
 * How much of each transcript's END to read, for a window of `windowHours`.
 *
 * Transcripts are append-only, so recent turns are always at the tail — but
 * they run past 100MB, and a bound that suits one day does not survive a
 * longer range. Measured on a real machine: at 24MB a 7-day window left 36.6%
 * of its bytes unread and a 30-day window 42.9%, silently, because a truncated
 * file still parses. The largest transcript there was 97MB.
 *
 * The cost is I/O and JSON.parse, which is why this scales with the range asked
 * for rather than always reading the maximum.
 */
export function tailFor(windowHours) {
  // A day's worth of turns is always near the end, so the cheap bound holds.
  if (windowHours <= 24) return 24 * 1024 * 1024;
  // Anything longer reads whole transcripts in practice. The headroom is
  // deliberate — this is the number that decides whether a report is complete,
  // and being generous costs seconds, not correctness.
  return 192 * 1024 * 1024;
}

/**
 * Transcripts that could hold a turn at or after `sinceMs`, with their sizes.
 *
 * A file untouched since the window opened cannot hold a line inside it, so it
 * is never opened. The `size` rides along because the caller needs it to decide
 * where to seek, and stat-ing twice for one number is pure waste.
 */
export function recentTranscripts(sinceMs) {
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
        const st = statSync(full);
        if (st.mtimeMs >= sinceMs) out.push({ file: full, size: st.size });
      } catch {
        // Rotated away mid-scan — skip.
      }
    }
  }
  return out;
}

/**
 * Stream one transcript's tail, handing each parsed line to `onLine`.
 *
 * The fiddly parts are here so they are maintained once: a big file is started
 * mid-way (there is no index to seek to a line boundary with), so the first
 * line read is usually a fragment that fails to parse and is skipped; and lines
 * straddle chunk boundaries, so the buffer is split on newlines rather than per
 * chunk.
 *
 * Nothing is accumulated — callers keep only what they need, which is what lets
 * a whole-corpus scan run without holding the corpus.
 */
export async function readTailLines(file, size, tailBytes, onLine) {
  const start = size > tailBytes ? size - tailBytes : 0;
  let buf = null;
  for await (const chunk of createReadStream(file, { start })) {
    buf = buf && buf.length ? Buffer.concat([buf, chunk]) : chunk;
    let idx;
    while ((idx = buf.indexOf(0x0a)) !== -1) {
      const line = buf.subarray(0, idx).toString("utf8");
      buf = buf.subarray(idx + 1);
      if (!line.trim()) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      onLine(o);
    }
  }
}
