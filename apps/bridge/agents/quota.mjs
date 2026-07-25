/**
 * Plan quota — how much of an agent's rate-limit window is spent right now.
 *
 * This is the honest headline for subscription plans, where "dollars" is not a
 * quantity that exists: a Codex Plus or Claude Max seat bills a flat fee and
 * meters you against rolling windows instead. So the question worth answering
 * on a dashboard isn't "what did today cost" but "how much of my week is gone".
 *
 * Everything here is the agent's OWN reported figure, read from what it already
 * wrote on this machine. Nothing is derived, and nothing calls out to a
 * provider — see agents/admin-cost.mjs for the opt-in path that does.
 *
 * Coverage today:
 *   codex   full. Every `token_count` rollout event carries a `rate_limits`
 *           snapshot with a primary (5h) and secondary (weekly) window.
 *   claude  none. Claude Code receives its limits in API response headers and
 *           writes none of it to disk — verified across the transcript corpus,
 *           where every "rate limit" hit was prose in a conversation, not a
 *           field. Its quota would have to come from turns the bridge drives.
 */
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const CODEX_ROOT = path.join(os.homedir(), ".codex", "sessions");

/** Only the tail of a rollout is read: `rate_limits` rides every token_count
 *  event, so the newest snapshot is always near the end, and these files run to
 *  tens of MB. */
const TAIL_BYTES = 512 * 1024;

/** Newest `rollout-*.jsonl` under a YYYY/MM/DD tree, or null. Walks the date
 *  directories newest-first and stops at the first hit rather than listing
 *  every session ever recorded. */
function newestRollout(root = CODEX_ROOT) {
  if (!existsSync(root)) return null;
  const desc = (dir) => {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort()
        .reverse();
    } catch {
      return [];
    }
  };
  for (const y of desc(root)) {
    for (const m of desc(path.join(root, y))) {
      for (const d of desc(path.join(root, y, m))) {
        const dir = path.join(root, y, m, d);
        let files;
        try {
          files = readdirSync(dir)
            .filter((f) => f.startsWith("rollout-") && f.endsWith(".jsonl"))
            .map((f) => path.join(dir, f));
        } catch {
          continue;
        }
        if (!files.length) continue;
        return files
          .map((f) => {
            try {
              return { f, mtime: statSync(f).mtimeMs };
            } catch {
              return null;
            }
          })
          .filter(Boolean)
          .sort((a, b) => b.mtime - a.mtime)[0].f;
      }
    }
  }
  return null;
}

/** Read the last `rate_limits` snapshot (with its timestamp) out of a rollout. */
async function lastRateLimits(file) {
  let start = 0;
  try {
    const { size } = statSync(file);
    start = Math.max(0, size - TAIL_BYTES);
  } catch {
    return null;
  }
  let buf = "";
  for await (const chunk of createReadStream(file, { start, encoding: "utf8" })) buf += chunk;
  // Starting mid-file can slice a line in half; drop the fragment.
  const lines = buf.split("\n");
  if (start > 0) lines.shift();
  let found = null;
  for (const line of lines) {
    if (!line.includes('"rate_limits"')) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const rl = o?.payload?.rate_limits;
    if (rl) found = { at: o.timestamp || null, rl };
  }
  return found;
}

/** One rolling window, as the app renders it. */
function window(w, label) {
  if (!w || typeof w.used_percent !== "number") return null;
  return {
    label,
    usedPercent: w.used_percent,
    windowMinutes: w.window_minutes ?? null,
    // Codex reports epoch SECONDS; the app wants an ISO instant.
    resetsAt: typeof w.resets_at === "number" ? new Date(w.resets_at * 1000).toISOString() : null,
  };
}

/**
 * Current quota per agent. Agents with nothing to report are simply absent —
 * an empty object means "no plan metering visible on this host", which the UI
 * shows as nothing rather than as 0%.
 */
export async function readQuota() {
  const out = {};
  const file = newestRollout();
  if (file) {
    const snap = await lastRateLimits(file).catch(() => null);
    if (snap) {
      const windows = [
        window(snap.rl.primary, "Session"),
        window(snap.rl.secondary, "Weekly"),
      ].filter(Boolean);
      if (windows.length) {
        out.codex = {
          planType: snap.rl.plan_type ?? null,
          // Stale snapshots matter: this is "as of the last Codex turn", which
          // could be days ago. The app dims the card when it's old.
          observedAt: snap.at,
          windows,
        };
      }
    }
  }
  return out;
}

export { newestRollout, lastRateLimits };
