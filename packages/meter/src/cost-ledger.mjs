/**
 * Cost ledger — official, agent-reported turn metrics, persisted by us.
 *
 * The problem this solves: most agent CLIs report their real cost/token spend
 * ONLY on the wire, in the envelope that closes a turn, and never write it to
 * their own transcript. Claude Code is the clearest case — `claude -p
 * --output-format stream-json` ends with
 *
 *   { type:"result", total_cost_usd: 0.0849865, duration_ms, usage:{…},
 *     modelUsage:{ "claude-opus-5[1m]": { costUSD, contextWindow, … } } }
 *
 * …and none of that lands in ~/.claude/projects/**.jsonl. Read the transcript
 * later and the dollars are simply gone. So when the bridge is the one driving
 * the turn, we capture that envelope here.
 *
 * Everything stored is COPIED VERBATIM from the agent. We never price tokens
 * ourselves: a number is either what the CLI reported or it is absent. That is
 * the whole point of this module — see docs/faq for why derived costs were
 * dropped. `source` records which envelope a row came from so a consumer can
 * tell official USD from token-only rows.
 *
 * Storage is append-only JSONL at ~/.pounce/usage.jsonl, matching the rest of
 * ~/.pounce (config.json, tunnel.json). Deliberately not SQLite: node:sqlite is
 * optional in this codebase (cursor/opencode both carry no-sqlite fallbacks)
 * and the bridge ships as a `bun --compile` binary, so a hard native dep would
 * regress those runtimes for what is append-plus-sum over a few hundred rows.
 * Reads are threadId-filtered scans with a bounded tail; if this ever needs
 * indexed queries, this file is the only thing that changes.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import os from "node:os";
import path from "node:path";

const DIR = path.join(os.homedir(), ".pounce");
export const LEDGER_FILE = path.join(DIR, "usage.jsonl");

// Rotate past this so an always-on bridge can't grow an unbounded file. One row
// is ~300B, so this is ~30k turns of history — far more than any thread needs.
const MAX_BYTES = 8 * 1024 * 1024;

/** Sum of every numeric leaf we care about, tolerating absent fields. */
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * Record one completed turn. `costUsd` MUST be null unless the agent itself
 * reported a dollar figure — callers never compute it.
 *
 * Best-effort by design: a turn that fails to log its metrics must not fail the
 * turn, so every error here is swallowed.
 */
export function recordTurn(row) {
  try {
    if (!row || !row.agent || !row.threadId) return;
    mkdirSync(DIR, { recursive: true });
    rotateIfLarge();
    const line = JSON.stringify({
      ts: row.ts || new Date().toISOString(),
      agent: row.agent,
      threadId: row.threadId,
      turnId: row.turnId || null,
      model: row.model || null,
      // null (not 0) when the agent reported no dollar figure — a real 0 and
      // "unknown" are different answers and the UI renders them differently.
      costUsd: typeof row.costUsd === "number" && Number.isFinite(row.costUsd) ? row.costUsd : null,
      tokens: row.tokens || null,
      contextWindow: row.contextWindow ?? null,
      durationMs: row.durationMs ?? null,
      source: row.source || "cli-result",
    });
    appendFileSync(LEDGER_FILE, `${line}\n`);
  } catch {}
}

/** Keep the newest half when the ledger outgrows MAX_BYTES. */
function rotateIfLarge() {
  try {
    if (!existsSync(LEDGER_FILE) || statSync(LEDGER_FILE).size <= MAX_BYTES) return;
    renameSync(LEDGER_FILE, `${LEDGER_FILE}.1`);
    writeFileSync(LEDGER_FILE, "");
  } catch {}
}

/**
 * Aggregate every ledger row for one thread.
 *
 * Returns null when we have no rows at all — callers distinguish "we never
 * drove a turn here" (no cost knowable) from "we drove turns that reported
 * $0". `costComplete` is false when some rows carried no dollar figure, so the
 * UI can mark a total as covering only part of the thread.
 */
export async function threadTotals(agent, threadId) {
  if (!existsSync(LEDGER_FILE)) return null;
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, reasoning: 0 };
  let cost = 0,
    costRows = 0,
    rows = 0,
    model = null,
    contextWindow = null,
    durationMs = 0;
  let rl;
  try {
    rl = createInterface({ input: createReadStream(LEDGER_FILE, "utf8"), crlfDelay: Infinity });
  } catch {
    return null;
  }
  for await (const line of rl) {
    if (!line) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.agent !== agent || o.threadId !== threadId) continue;
    rows++;
    if (typeof o.costUsd === "number") {
      cost += o.costUsd;
      costRows++;
    }
    if (o.model) model = o.model; // last model wins — matches the thread's current one
    if (o.contextWindow) contextWindow = o.contextWindow;
    durationMs += num(o.durationMs);
    const t = o.tokens || {};
    tokens.input += num(t.input);
    tokens.output += num(t.output);
    tokens.cacheRead += num(t.cacheRead);
    tokens.cacheCreation += num(t.cacheCreation);
    tokens.reasoning += num(t.reasoning);
  }
  if (!rows) return null;
  return {
    rows,
    model,
    contextWindow,
    durationMs,
    tokens,
    // No priced rows at all → no cost, not a zero total.
    cost: costRows ? cost : null,
    costComplete: costRows === rows,
  };
}
