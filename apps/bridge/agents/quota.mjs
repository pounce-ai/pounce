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
 * Coverage today — only Codex publishes a live METER locally. The rest publish
 * their plan IDENTITY, which is worth showing: a card that lists one agent
 * reads as "the others are idle", when the truth is "the others don't say".
 *
 *   codex     meter. Every `token_count` rollout event carries a `rate_limits`
 *             snapshot with a primary (5h) and secondary (weekly) window.
 *   claude    plan only. `~/.claude/.credentials.json` names the tier
 *             (subscriptionType / rateLimitTier); the consumption arrives in
 *             API response headers and is never written to disk — verified by
 *             scanning a full transcript for structured rate-limit fields and
 *             finding none.
 *   cursor    plan only, and not from a file: `cursor-agent about --format
 *             json` reports `subscriptionTier`.
 *   opencode  plan only. The `opencode-go` credential says a hosted plan is
 *             configured, but nothing local carries its allowance — `opencode
 *             stats` is spend derived from the same session DB the activity
 *             chart already reads. A real Go meter needs a call to opencode's
 *             API, which belongs in the opt-in path (agents/admin-cost.mjs),
 *             not here.
 *
 * Reading credentials files: only the non-secret plan fields are touched, and
 * nothing read here is ever returned verbatim — tokens are not parsed, logged
 * or forwarded.
 */
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";

import { agentEnv, binPath } from "./env.mjs";

const execFile = promisify(execFileCb);

const CODEX_ROOT = path.join(os.homedir(), ".codex", "sessions");
const CLAUDE_CREDS = path.join(os.homedir(), ".claude", ".credentials.json");
const OPENCODE_AUTH = path.join(os.homedir(), ".local", "share", "opencode", "auth.json");

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
  // Backwards: Codex writes a rate_limits snapshot on every API call, so a
  // 512KB tail holds hundreds of them and only the newest matters. Parsing
  // forwards meant JSON.parse-ing them all and discarding every one but the last.
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"rate_limits"')) continue;
    let o;
    try {
      o = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const rl = o?.payload?.rate_limits;
    if (rl) return { at: o.timestamp || null, rl };
  }
  return null;
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

/** Pretty name for Claude's rate-limit tier: `default_claude_max_20x` → "Max 20x".
 *  Falls back to the plain subscription type when the tier is unfamiliar. */
function claudePlanLabel(subscriptionType, rateLimitTier) {
  const m = /claude_(max)_(\d+)x/.exec(rateLimitTier ?? "");
  if (m) return `Max ${m[2]}x`;
  if (/pro/i.test(rateLimitTier ?? "")) return "Pro";
  return subscriptionType ? subscriptionType.replace(/^\w/, (c) => c.toUpperCase()) : null;
}

/** Claude's plan name. Only two non-secret fields are read from the credentials
 *  file; the tokens beside them are never parsed or returned. */
function readClaudePlan() {
  if (!existsSync(CLAUDE_CREDS)) return null;
  try {
    const o = JSON.parse(readFileSync(CLAUDE_CREDS, "utf8"))?.claudeAiOauth ?? {};
    const label = claudePlanLabel(o.subscriptionType, o.rateLimitTier);
    return label ? { planType: label, note: "Anthropic doesn't publish limits locally" } : null;
  } catch {
    return null;
  }
}

/** opencode: a hosted plan is only *configured* — its allowance isn't local. */
function readOpencodePlan() {
  if (!existsSync(OPENCODE_AUTH)) return null;
  try {
    const auth = JSON.parse(readFileSync(OPENCODE_AUTH, "utf8")) ?? {};
    if (auth["opencode-go"]) return { planType: "Go", note: "allowance not published locally" };
    // A bare API key is pay-as-you-go: there's no plan window to be near.
    if (auth.opencode) return { planType: null, note: "pay-as-you-go, no plan window" };
    return null;
  } catch {
    return null;
  }
}

/** Cursor keeps nothing useful on disk, but its CLI reports the tier. Short
 *  timeout and a swallowed failure: a missing or slow CLI must never hold up
 *  the dashboard. */
async function readCursorPlan() {
  try {
    // agentEnv() is how every other adapter finds a CLI: a GUI app inherits
    // none of the shell's PATH, so a bare "cursor-agent" resolves only when the
    // bridge was started from a terminal.
    const { stdout } = await execFile(binPath("cursor-agent"), ["about", "--format", "json"], {
      timeout: 6000,
      maxBuffer: 1 << 20,
      env: agentEnv(),
    });
    const tier = JSON.parse(stdout)?.subscriptionTier;
    return tier ? { planType: tier, note: "no local meter" } : null;
  } catch {
    return null;
  }
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

  // Agents with a plan but no local meter. They carry an empty `windows` and a
  // `note` saying why, so the card can list them honestly instead of implying
  // they're unused. Cursor's read shells out, so it runs alongside the rest.
  const [claude, cursor] = await Promise.all([Promise.resolve(readClaudePlan()), readCursorPlan()]);
  const opencode = readOpencodePlan();
  for (const [agent, plan] of [
    ["claude", claude],
    ["cursor", cursor],
    ["opencode", opencode],
  ]) {
    if (plan)
      out[agent] = { planType: plan.planType, note: plan.note, observedAt: null, windows: [] };
  }
  return out;
}
