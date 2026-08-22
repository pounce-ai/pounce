/**
 * Per-thread usage — the shape every adapter's getUsage() returns.
 *
 * Hard rule: an adapter puts a dollar figure here ONLY if the agent itself
 * reported one. No adapter multiplies tokens by a rate — the price table that
 * used to live in server.mjs is gone and is not coming back. In practice:
 *
 *   claude    tokens from the transcript; USD only for turns the bridge drove
 *             (captured off the stream-json result envelope → cost-ledger)
 *   opencode  tokens AND USD per assistant message, straight from its own db
 *   codex     tokens only — it bills against a plan, so it reports rate-limit
 *             consumption and plan type instead of dollars
 *   cursor    neither
 *
 * `costSource` says which of three kinds of number this is, and they are not
 * interchangeable: "agent" is what the tool reported, "admin-api" is what the
 * org was billed, and "ccusage-est" is tokens priced at public list rates by
 * ../agents/ccusage.mjs. The estimate is applied ABOVE this layer (host.mjs
 * fills a null, server.mjs fills a null day) precisely so that adapters keep
 * reporting only what they know, and so a real figure is never overwritten.
 *
 * `cost: null` therefore means no source at all could speak — distinct from a
 * real `0`. When cost covers only part of a thread (Claude threads with turns
 * taken outside Pounce), `costComplete` is false and the UI marks it partial.
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
  lastModel = null,
  lastModelAt = null,
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
    // What the thread's most recent turn actually ran on, and when. Distinct
    // from `model` (its dominant one, by output tokens): a thread that spent
    // most of its life on one model and was then moved — by a fallback, or by
    // someone typing /model in a terminal — still reports the old one there.
    // This pair is what lets a client notice the move.
    lastModel,
    lastModelAt,
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
