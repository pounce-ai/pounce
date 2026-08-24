/**
 * @pounce/meter — what a coding agent cost, read off the machine it ran on.
 *
 * Four independent answers to "what did this cost", because no single source
 * covers the question and they disagree in ways that matter:
 *
 *   • cost-ledger — the agent's OWN reported dollars, captured from the
 *     envelope that closes a turn. Authoritative, but only exists for turns
 *     the host actually drove.
 *   • admin-cost  — the organization's billing report from Anthropic's Admin
 *     API. Official, org-wide, opt-in (needs an admin key), daily buckets.
 *   • ccusage     — an estimate parsed from local transcripts, covering turns
 *     nobody was there to record. Fills the nulls; never overrides a real one.
 *   • quota       — for subscription seats, where dollars are not a quantity
 *     that exists: how much of a rolling plan window is spent right now.
 *
 * Plus the two shapes that make the numbers legible: `blocks` (spend folded
 * into the agent's own rate-limit windows), `attribution` (which tool, file
 * and shell command filled a context window), and `atif` (a whole thread as a
 * standard trajectory document, for audit export and eval harnesses).
 *
 * Everything here READS. Nothing drives an agent, opens a socket, or needs the
 * bridge — the one host-specific concern, finding an agent's CLI, is injected
 * through `configureMeterHost`. That is what lets the same code run inside the
 * bridge on a developer's laptop and inside a collector that never sees a UI.
 */

export { configureMeterHost, resetMeterHost } from "./host.mjs";

// Official dollars — agent-reported, then org billing.
export { LEDGER_FILE, recordTurn, threadTotals } from "./cost-ledger.mjs";
export { dailyCost as adminDailyCost, resetCostCache } from "./admin-cost.mjs";

// Estimated dollars — parsed from transcripts when nothing official exists.
export {
  ccusageAvailable,
  dailyCost,
  dailyUsage,
  ensureCcusage,
  findCcusage,
  parseDaily,
  parseDailyUsage,
  parseSession,
  resetCcusageCache,
  SUPPORTED,
  threadCost,
} from "./ccusage.mjs";

// Subscription plans — window burn, not dollars.
export {
  mapClaudeUsage,
  readClaudeQuota,
  readOpencodeQuota,
  readQuota,
  resetQuotaCache,
} from "./quota.mjs";

// The shapes: rate-limit windows, and what filled them.
export { BLOCK_HOURS, foldBlocks, readBlocks } from "./blocks.mjs";
export {
  attribute,
  FALLBACK_CHARS_PER_TOKEN,
  fileKind,
  fitPreamble,
  foldSmall,
  FOLD_THRESHOLD,
  ITEMS,
  MIN_FIT_POINTS,
  readAttribution,
  scanEntries,
  shellSub,
  shellVerb,
} from "./attribution.mjs";

// Transcript access the readers above share.
export {
  CLAUDE_ROOT,
  HOUR_MS,
  readTailLines,
  recentTranscripts,
  SYNTHETIC_MODEL,
  tailFor,
} from "./claude-transcripts.mjs";

// The adapter-facing result shape, and trajectory export.
export { noUsage, usageResult } from "./usage.mjs";
export { toAtif } from "./atif.mjs";
