/**
 * Per-thread usage — the shape every adapter's getUsage() returns.
 *
 * Hard rule: a dollar figure appears here ONLY if the agent itself reported
 * one. We removed the price table that used to live in server.mjs; nothing in
 * the bridge multiplies tokens by a rate any more. In practice:
 *
 *   claude    tokens from the transcript; USD only for turns the bridge drove
 *             (captured off the stream-json result envelope → cost-ledger)
 *   opencode  tokens AND USD per assistant message, straight from its own db
 *   codex     tokens only — it bills against a plan, so it reports rate-limit
 *             consumption and plan type instead of dollars
 *   cursor    neither
 *
 * `cost: null` means "not knowable", which is distinct from a real `0`. When
 * cost covers only part of a thread (Claude threads with turns taken outside
 * Pounce), `costComplete` is false and the UI marks the number as partial.
 *
 * Context fill (`contextUsed` / `contextWindow`) is a different measurement to
 * the cumulative `tokens` above and must not be confused with it: `tokens.total`
 * sums every turn ever taken, while `contextUsed` is the size of the single most
 * recent request — what the model is actually carrying right now. A 60M-token
 * thread is not 60× over a 1M window; it is one prompt of a few hundred K sent
 * many times. Compaction shows up naturally, since the next request after one is
 * simply smaller. The window is only ever the agent's own stated number — see
 * each adapter for where it comes from, and note that guessing it from a model
 * name is wrong (a `[1m]` Opus variant and a 200K one share a canonical name).
 */

/** Nothing to report — `reason` tells the UI why so it can stay quiet. */
export const noUsage = (reason) => ({ available: false, reason });

const n = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * Normalize an adapter's raw numbers into the wire shape. Keeps the field names
 * the app already consumes (tokens.total, cost, costComplete, model, models)
 * and adds official-but-non-USD signals where an agent provides them.
 */
export function usageResult({
  tokens = {},
  cost = null,
  costComplete = true,
  costSource = null,
  model = null,
  models = [],
  messages = 0,
  contextWindow = null,
  contextUsed = null,
  rateLimit = null,
}) {
  const t = {
    input: n(tokens.input),
    output: n(tokens.output),
    cacheRead: n(tokens.cacheRead),
    cacheCreation: n(tokens.cacheCreation),
    reasoning: n(tokens.reasoning),
  };
  // Cache reads/writes are real billed input, so they belong in the total —
  // this is the number the status bar shows.
  const total = t.input + t.output + t.cacheRead + t.cacheCreation;
  return {
    available: true,
    model,
    models,
    tokens: { ...t, total },
    // Round only for display sanity; never invent a value that wasn't reported.
    cost: cost == null ? null : Math.round(cost * 10000) / 10000,
    costComplete: cost == null ? true : costComplete,
    costSource: cost == null ? null : costSource,
    messages,
    contextWindow,
    contextUsed,
    rateLimit,
  };
}
