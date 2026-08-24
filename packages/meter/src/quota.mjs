/**
 * Plan quota — how much of an agent's rate-limit window is spent right now.
 *
 * This is the honest headline for subscription plans, where "dollars" is not a
 * quantity that exists: a Codex Plus or Claude Max seat bills a flat fee and
 * meters you against rolling windows instead. So the question worth answering
 * on a dashboard isn't "what did today cost" but "how much of my week is gone".
 *
 * Everything here is the agent's OWN reported figure — read from what it wrote
 * on this machine, or asked of the agent's own service with the credential the
 * agent already stored here. Nothing is derived.
 *
 * Coverage today — Codex publishes a live METER locally, opencode publishes one
 * over the wire. The rest publish only their plan IDENTITY, which is still worth
 * showing: a card that lists one agent reads as "the others are idle", when the
 * truth is "the others don't say".
 *
 *   codex     meter, local. Every `token_count` rollout event carries a
 *             `rate_limits` snapshot with a primary (5h) and secondary (weekly)
 *             window.
 *   opencode  meter, remote. Nothing local carries the Go allowance (`opencode
 *             stats` is spend derived from the same session DB the activity
 *             chart already reads), but opencode now serves it:
 *             `GET /zen/go/v1/usage` with the `opencode-go` key already in
 *             auth.json returns rolling / weekly / monthly percentages.
 *   claude    meter, remote, and the most invasive of the three. NOTHING local
 *             carries the consumption — not the transcripts, not the
 *             credentials file — so the only source is the endpoint Claude
 *             Code's own `/usage` view calls, with the credential Claude Code
 *             already stored (Keychain on macOS, a JSON file elsewhere). That
 *             endpoint is undocumented and unversioned: see readClaudeQuota.
 *   cursor    plan only, and not from a file: `cursor-agent about --format
 *             json` reports `subscriptionTier`.
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

import { agentEnv, binPath } from "./host.mjs";

const execFile = promisify(execFileCb);

/** Run a command and capture it, in the shape the credential reader wants.
 *  Never throws: a missing binary or a refused Keychain prompt is an ordinary
 *  "no" here, not a failure of the dashboard. */
async function execCapture(cmd, args, timeout) {
  try {
    const { stdout } = await execFile(cmd, args, { timeout, maxBuffer: 1 << 20 });
    return { code: 0, out: stdout };
  } catch (e) {
    return { code: e?.code ?? 1, out: e?.stdout ?? "" };
  }
}

const CODEX_ROOT = path.join(os.homedir(), ".codex", "sessions");
const CLAUDE_CREDS = path.join(os.homedir(), ".claude", ".credentials.json");
const OPENCODE_AUTH = path.join(os.homedir(), ".local", "share", "opencode", "auth.json");
const ZEN_USAGE = "https://opencode.ai/zen/go/v1/usage";
/** The endpoint Claude Code's own `/usage` view calls (found in the CLI, not in
 *  any docs — see readClaudeQuota for what that costs us). */
const CLAUDE_USAGE = "https://api.anthropic.com/api/oauth/usage";
/** Where the macOS native build keeps the live credential; the JSON file beside
 *  it goes stale. */
const CLAUDE_KEYCHAIN_ITEM = "Claude Code-credentials";
const UA = "Pounce/1.0 (https://use-pounce.com)";

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

/**
 * Claude Code's credentials, from wherever this machine actually keeps them.
 *
 * Two stores, and the difference matters: the macOS native build keeps the live
 * credential in the KEYCHAIN and leaves `~/.claude/.credentials.json` behind as
 * a stale copy — on the machine this was written, the file was 33 days expired
 * and still claimed a tier the account no longer had, so the dashboard was
 * confidently showing the wrong plan. Whichever copy expires LATER is the one
 * telling the truth.
 *
 * Only the plan fields and the access token are read, the token is used for
 * exactly one request, and neither is ever logged or returned to a caller.
 */
async function claudeCredentials({ exec, env = process.env } = {}) {
  const found = [];
  if (existsSync(CLAUDE_CREDS)) {
    try {
      const o = JSON.parse(readFileSync(CLAUDE_CREDS, "utf8"))?.claudeAiOauth;
      if (o) found.push(o);
    } catch {
      // an unreadable file is simply not a source
    }
  }
  // Keychain, macOS only. `security` prompts the first time a given binary asks
  // for an item it has no ACL entry for — so this must never be on a path that
  // blocks a dashboard read, which is why the whole thing is memoized and every
  // failure (denied, absent, non-mac) degrades to the file above.
  if (process.platform === "darwin" && exec) {
    try {
      const { code, out } = await exec(
        "security",
        ["find-generic-password", "-s", CLAUDE_KEYCHAIN_ITEM, "-w"],
        4000,
      );
      if (code === 0 && out.trim()) {
        const o = JSON.parse(out)?.claudeAiOauth;
        if (o) found.push(o);
      }
    } catch {
      // no keychain access; the file is what we have
    }
  }
  if (env.CLAUDE_CODE_OAUTH_TOKEN) {
    // The documented escape hatch, for a host with neither store (a container,
    // a CI box). No expiry is knowable, so treat it as live.
    found.push({ accessToken: env.CLAUDE_CODE_OAUTH_TOKEN, expiresAt: Number.POSITIVE_INFINITY });
  }
  if (!found.length) return null;
  return found.sort((a, b) => (b.expiresAt ?? 0) - (a.expiresAt ?? 0))[0];
}

/**
 * `GET /api/oauth/usage` → the windows the app renders.
 *
 * Read defensively on purpose: this is the endpoint Claude Code's own `/usage`
 * calls, which makes it undocumented and unversioned — it can change shape
 * without notice, and when it does this must degrade to the plan name rather
 * than throw into a dashboard. Anything without a numeric percentage is
 * dropped rather than shown as 0%.
 *
 * Exported so the mapping can be tested against a recorded payload without a
 * token, and adjusted in one place when the shape moves.
 */
export function mapClaudeUsage(json) {
  // `limits` is the list Claude Code's own /usage renders, and the only part of
  // this payload that is a rate-limit window. The rest of the object is a
  // minefield of things that merely LOOK like one: `spend` carries a `percent`
  // that is dollars, `extra_usage` a `utilization` that is a credit balance,
  // and a dozen codenamed scopes (`nimbus_quill`, `tangelo`) carry partial
  // copies of the same windows. Mapping "anything with a number" produced six
  // bars, two of them money.
  const limits = Array.isArray(json?.limits) ? json.limits : null;
  if (limits) {
    return limits
      .filter((l) => l && typeof l.percent === "number" && Number.isFinite(l.percent))
      .map((l) => ({
        label: claudeWindowLabel(l),
        usedPercent: l.percent,
        windowMinutes: null,
        resetsAt: typeof l.resets_at === "string" ? l.resets_at : null,
      }))
      .sort((a, b) => rankClaudeWindow(a) - rankClaudeWindow(b));
  }
  // Older shape, kept as a fallback because it is what the top level still
  // exposes: the same two windows under their durations.
  const windows = [];
  for (const [key, v] of [
    ["session", json?.five_hour],
    ["weekly_all", json?.seven_day],
  ]) {
    const pct = typeof v?.utilization === "number" ? v.utilization : v?.percent;
    if (typeof pct !== "number" || !Number.isFinite(pct)) continue;
    windows.push({
      label: claudeWindowLabel({ kind: key }),
      usedPercent: pct,
      windowMinutes: null,
      resetsAt: typeof v.resets_at === "string" ? v.resets_at : null,
    });
  }
  return windows;
}

/** Shortest window first, the way Codex's card already reads: the session limit
 *  is the one about to bite, the weekly one is what you pace against. */
const rankClaudeWindow = (w) => (w.label.startsWith("Weekly") ? 1 : 0);

/**
 * A window's name as a person would say it.
 *
 * `kind` is the authority (`session`, `weekly_all`, `weekly_scoped`) — naming
 * these by matching the KEY for the word "week" got the seven-day limit
 * labelled "Session", because the key spells the duration, not the word. A
 * scoped weekly limit is named after its model, because "your Opus allowance"
 * and "your allowance" are different facts and a card showing two bars both
 * called Weekly explains neither.
 */
function claudeWindowLabel(l) {
  const model = l?.scope?.model?.display_name || null;
  const base = /week/i.test(l?.kind ?? l?.group ?? "") ? "Weekly" : "Session";
  return model ? `${base} · ${model}` : base;
}

const CLAUDE_TTL_MS = 60_000;
let claudeCache = { at: 0, value: null };

/**
 * Claude's plan, and its meter when the account can be asked for one.
 *
 * The meter is the endpoint Claude Code's own `/usage` view calls, with the
 * credential Claude Code already stored on this machine. It is not refreshed
 * here: refreshing is the CLI's job, and racing it over the credential store is
 * how you invalidate someone's session. An expired token therefore falls back
 * to exactly what this returned before — the plan name, and a note saying so.
 */
export async function readClaudeQuota({
  fetchImpl = fetch,
  exec,
  env = process.env,
  now = Date.now(),
} = {}) {
  if (claudeCache.value && now - claudeCache.at < CLAUDE_TTL_MS) return claudeCache.value;
  const cred = await claudeCredentials({ exec, env }).catch(() => null);
  if (!cred) return null;
  const planType = claudePlanLabel(cred.subscriptionType, cred.rateLimitTier);
  const planOnly = (note) => ({ planType, note });

  if (!cred.accessToken || (cred.expiresAt ?? 0) <= now) {
    // Nothing to ask with. Not an error — Claude Code refreshes on next use.
    return planOnly("sign in to Claude Code for live limits");
  }
  let out;
  try {
    const res = await fetchImpl(CLAUDE_USAGE, {
      headers: {
        authorization: `Bearer ${cred.accessToken}`,
        "content-type": "application/json",
        "user-agent": UA,
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      out = planOnly(
        res.status === 401 || res.status === 403
          ? "sign in to Claude Code for live limits"
          : `Anthropic returned ${res.status}`,
      );
    } else {
      const windows = mapClaudeUsage(await res.json());
      out = windows.length
        ? { planType, note: null, observedAt: new Date(now).toISOString(), windows }
        : planOnly("no limits reported for this plan");
    }
  } catch {
    out = planOnly("couldn't reach Anthropic just now");
  }
  claudeCache = { at: now, value: out };
  return out;
}

/** The Go key opencode itself stores, or the env var its docs name. Only the
 *  key field is read; it is used for exactly one request and never returned. */
function opencodeGoKey(env = process.env) {
  if (existsSync(OPENCODE_AUTH)) {
    try {
      const key = JSON.parse(readFileSync(OPENCODE_AUTH, "utf8"))?.["opencode-go"]?.key;
      if (typeof key === "string" && key) return key;
    } catch {
      // fall through to the env var
    }
  }
  return env.OPENCODE_API_KEY || null;
}

/** Is a bare (non-Go) opencode key configured? That's pay-as-you-go: real
 *  dollars, no plan window to be near, so there is nothing to meter. */
function hasBareOpencodeKey() {
  if (!existsSync(OPENCODE_AUTH)) return false;
  try {
    const auth = JSON.parse(readFileSync(OPENCODE_AUTH, "utf8")) ?? {};
    return Boolean(auth.opencode);
  } catch {
    return false;
  }
}

/** `{ percent, resetsAt, status }` → the window shape the app renders. A window
 *  the service can't currently speak for is dropped, not shown as 0%. */
function goWindow(w, label) {
  if (!w || typeof w.percent !== "number") return null;
  if (w.status && w.status !== "ok") return null;
  return {
    label,
    usedPercent: w.percent,
    windowMinutes: null,
    resetsAt: typeof w.resetsAt === "string" ? w.resetsAt : null,
  };
}

/** Live meter, so it must not be re-fetched on every dashboard paint. The
 *  /v1/quota route memoizes for 60s too; this covers the other callers. */
const GO_TTL_MS = 60_000;
let goCache = { at: 0, value: null };

/**
 * opencode Go's plan usage, from opencode's own API.
 *
 * The one place in this file that leaves the machine — announced Aug 11 2026 and
 * the only way the Go allowance is knowable, since nothing writes it to disk.
 * The request carries the key opencode already stored here and goes nowhere but
 * opencode. Every failure degrades to the plan name plus a reason, because a
 * dashboard that drops a card when a network call fails reads as "that agent
 * isn't in use", which is a different and wrong claim.
 */
export async function readOpencodeQuota({
  fetchImpl = fetch,
  env = process.env,
  key = opencodeGoKey(env),
} = {}) {
  if (!key) {
    if (hasBareOpencodeKey()) return { planType: null, note: "pay-as-you-go, no plan window" };
    return null;
  }
  if (goCache.value && Date.now() - goCache.at < GO_TTL_MS) return goCache.value;

  let out;
  try {
    const res = await fetchImpl(ZEN_USAGE, {
      headers: { authorization: `Bearer ${key}`, "user-agent": UA },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) {
      // 401/403 is an ordinary outcome: the key may be a plain Zen key rather
      // than a Go seat. Say so instead of implying the plan is unused.
      out = {
        planType: "Go",
        note:
          res.status === 401 || res.status === 403
            ? "no Go plan on this key"
            : `opencode returned ${res.status}`,
      };
    } else {
      const usage = (await res.json())?.usage ?? {};
      const windows = [
        goWindow(usage.rolling, "Rolling"),
        goWindow(usage.weekly, "Weekly"),
        goWindow(usage.monthly, "Monthly"),
      ].filter(Boolean);
      out = windows.length
        ? // Read just now, unlike Codex's "as of the last turn" — so it can
          // never be dimmed as stale.
          { planType: "Go", note: null, observedAt: new Date().toISOString(), windows }
        : { planType: "Go", note: "opencode reported no windows" };
    }
  } catch {
    out = { planType: "Go", note: "couldn't reach opencode just now" };
  }
  goCache = { at: Date.now(), value: out };
  return out;
}

/** Drop the memo — for tests and for a credential change. */
export function resetQuotaCache() {
  goCache = { at: 0, value: null };
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

  // Cursor has a plan but no meter anywhere: it carries an empty `windows` and
  // a `note` saying why, so the card lists it honestly instead of implying it
  // is unused. Claude and opencode may carry real windows. All three shell out
  // or go over the network, so they run together.
  const [claude, cursor, opencode] = await Promise.all([
    readClaudeQuota({ exec: execCapture }),
    readCursorPlan(),
    readOpencodeQuota(),
  ]);
  for (const [agent, plan] of [
    ["claude", claude],
    ["cursor", cursor],
    ["opencode", opencode],
  ]) {
    if (plan)
      out[agent] = {
        planType: plan.planType,
        note: plan.note ?? null,
        observedAt: plan.observedAt ?? null,
        windows: plan.windows ?? [],
      };
  }
  return out;
}
