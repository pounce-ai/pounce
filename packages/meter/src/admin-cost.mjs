/**
 * Official org spend, via Anthropic's Admin Usage & Cost API — the opt-in path
 * to real dollars.
 *
 * Why this exists: Claude Code writes no cost to disk, so a host's transcripts
 * can show 20B tokens and still have no dollar figure attached (see
 * ./activity-index.mjs). The supported way to get the money number is the
 * organization's own billing report, which requires an Admin API key the user
 * pastes in — nothing is scraped, no browser session is touched.
 *
 * Contract (docs: manage-claude/usage-cost-api):
 *   GET https://api.anthropic.com/v1/organizations/cost_report
 *       ?starting_at=<ISO>&ending_at=<ISO>[&page=<cursor>]
 *   headers: x-api-key: sk-ant-admin…, anthropic-version: 2023-06-01
 *   • daily buckets only
 *   • amounts are decimal STRINGS in the currency's lowest unit (cents)
 *   • paginated via has_more / next_page
 *
 * Not available to individual accounts — only organizations. A 401/403 is
 * therefore an ordinary outcome, not an error worth shouting about: the caller
 * reports `available: false` and the dashboard keeps showing tokens.
 */
const BASE = "https://api.anthropic.com/v1/organizations/cost_report";
const API_VERSION = "2023-06-01";
const UA = "Pounce/1.0 (https://use-pounce.com)";

/** Cache: this is billing data that lands within ~5min and the docs ask for at
 *  most one poll a minute. A dashboard refresh must not hammer it. */
const TTL_MS = 5 * 60_000;
let cache = { at: 0, key: "", value: null };

const isoDay = (d) => `${d.toISOString().slice(0, 10)}T00:00:00Z`;

/** Amounts arrive as decimal strings in cents; return dollars. */
function toDollars(amount) {
  const cents = typeof amount === "string" ? Number.parseFloat(amount) : Number(amount);
  return Number.isFinite(cents) ? cents / 100 : 0;
}

/**
 * Pull every cost bucket in the window, following pagination.
 *
 * The response shape is read defensively: this is a live third-party contract
 * we can't exercise in tests without a real org key, so unknown fields are
 * ignored rather than assumed, and any parse surprise degrades to "no data"
 * instead of throwing into the dashboard.
 */
async function fetchAll(apiKey, startingAt, endingAt, signal) {
  const byDay = new Map();
  let page = null;
  // Bounded: 31 daily buckets max per the docs, so this can't spin.
  for (let i = 0; i < 40; i++) {
    const qs = new URLSearchParams({ starting_at: startingAt, ending_at: endingAt });
    if (page) qs.set("page", page);
    const res = await fetch(`${BASE}?${qs}`, {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": API_VERSION,
        "user-agent": UA,
      },
      signal,
    });
    if (!res.ok) {
      // 401/403 = not an org, or a key without the scope. Expected, not fatal.
      return { ok: false, status: res.status, byDay };
    }
    const json = await res.json();
    for (const bucket of json?.data ?? []) {
      const day = typeof bucket?.starting_at === "string" ? bucket.starting_at.slice(0, 10) : null;
      if (!day) continue;
      let sum = 0;
      for (const r of bucket?.results ?? []) sum += toDollars(r?.amount ?? r?.cost ?? 0);
      byDay.set(day, (byDay.get(day) ?? 0) + sum);
    }
    if (!json?.has_more || !json?.next_page) break;
    page = json.next_page;
  }
  return { ok: true, status: 200, byDay };
}

/**
 * Daily USD for the last `days`, keyed YYYY-MM-DD.
 *
 * Returns `{ available: false, reason }` when there's no key or the org can't
 * serve it — the caller must not turn that into zeros.
 */
export async function dailyCost(apiKey, { days = 30, now = new Date() } = {}) {
  if (!apiKey) return { available: false, reason: "no-admin-key" };
  const end = new Date(now.getTime() + 24 * 60 * 60_000); // exclusive, covers today
  const start = new Date(now.getTime() - (days - 1) * 24 * 60 * 60_000);
  const startingAt = isoDay(start);
  const endingAt = isoDay(end);
  const key = `${startingAt}|${endingAt}`;
  if (cache.value && cache.key === key && Date.now() - cache.at < TTL_MS) return cache.value;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20_000);
  let out;
  try {
    const { ok, status, byDay } = await fetchAll(apiKey, startingAt, endingAt, ctl.signal);
    out = ok
      ? { available: true, byDay: Object.fromEntries(byDay), source: "admin-api" }
      : {
          available: false,
          reason: status === 401 || status === 403 ? "not-authorized" : `http-${status}`,
        };
  } catch {
    out = { available: false, reason: "unreachable" };
  } finally {
    clearTimeout(timer);
  }
  cache = { at: Date.now(), key, value: out };
  return out;
}

/** Drop the memo — used when the key changes. */
export function resetCostCache() {
  cache = { at: 0, key: "", value: null };
}
