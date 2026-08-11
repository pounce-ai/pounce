/**
 * The three overlays, and the frame they share.
 *
 * The rule most of these pin is a coverage rule, not a precedence rule: the
 * ledger sees only the turns Pounce drove, the reports see every transcript,
 * and getting that backwards costs real money on the dashboard without
 * breaking anything.
 */
import { describe, expect, it } from "vitest";
import {
  mergeBilledCost,
  mergeEstimatedCost,
  mergeTokens,
  overlayDays,
} from "./series-overlay.mjs";

/** One day of series, in the shape activity-index produces. */
const day = (date, cost, byAgent = {}) => ({
  date,
  sessions: 1,
  messages: 10,
  tokens: 1000,
  cost,
  byAgent,
});

const series = (...days) => ({
  days,
  totals: { sessions: 1, messages: 10, tokens: 1000, cost: null, costComplete: true },
});

describe("a day the ledger partly covered", () => {
  // The measured regression, with its real numbers: one bridge-driven turn on
  // 2026-07-31 reported $19.02, and that non-null figure used to block the
  // report's $553.73 for the whole day — 96% of a 30-day window's error.
  const partial = series(
    day("2026-07-31", 19.02, { claude: { sessions: 1, messages: 10, tokens: 1000, cost: 19.02 } }),
  );
  const report = { "2026-07-31": { total: 553.73, byAgent: { claude: 553.73 } } };

  it("takes the report's figure over the ledger's subset", () => {
    const out = mergeEstimatedCost(partial, report);
    expect(out.days[0].cost).toBe(553.73);
    expect(out.totals.cost).toBe(553.73);
  });

  it("marks the number as priced rather than billed", () => {
    const out = mergeEstimatedCost(partial, report);
    expect(out.days[0].costEstimated).toBe(true);
    expect(out.days[0].byAgent.claude.costEstimated).toBe(true);
    expect(out.totals.costEstimated).toBe(true);
  });

  it("keeps the counts the ledger row carried", () => {
    const out = mergeEstimatedCost(partial, report);
    expect(out.days[0].byAgent.claude.tokens).toBe(1000);
    expect(out.days[0].byAgent.claude.messages).toBe(10);
  });
});

describe("agents the report cannot read", () => {
  it("leaves their ledger dollars alone instead of zeroing them", () => {
    // ccusage has no reader for Cursor, so its silence is not a zero.
    const s = series(
      day("2026-08-01", 12, {
        claude: { sessions: 1, messages: 5, tokens: 900, cost: 2 },
        cursor: { sessions: 1, messages: 5, tokens: 100, cost: 10 },
      }),
    );
    const out = mergeEstimatedCost(s, { "2026-08-01": { total: 40, byAgent: { claude: 40 } } });
    expect(out.days[0].byAgent.cursor.cost).toBe(10);
    expect(out.days[0].byAgent.cursor.costEstimated).toBeUndefined();
    // The day is the sum of its rows: the report's claude plus cursor's ledger.
    expect(out.days[0].cost).toBe(50);
  });

  it("gives an agent with no row at all one, so its spend still counts", () => {
    const out = mergeEstimatedCost(series(day("2026-08-01", null)), {
      "2026-08-01": { total: 3, byAgent: { opencode: 3 } },
    });
    expect(out.days[0].byAgent.opencode).toMatchObject({ cost: 3, tokens: 0, sessions: 0 });
  });
});

describe("days the series never saw", () => {
  it("appends them, in date order", () => {
    const out = mergeEstimatedCost(series(day("2026-08-02", null)), {
      "2026-08-01": { total: 5, byAgent: { claude: 5 } },
    });
    expect(out.days.map((d) => d.date)).toEqual(["2026-08-01", "2026-08-02"]);
    expect(out.totals.cost).toBe(5);
  });
});

describe("a report with no per-agent detail", () => {
  it("fills a blank day", () => {
    const out = mergeEstimatedCost(series(day("2026-08-01", null)), {
      "2026-08-01": { total: 7, byAgent: {} },
    });
    expect(out.days[0].cost).toBe(7);
  });

  it("won't overwrite a known figure it can't reconcile agent by agent", () => {
    const out = mergeEstimatedCost(series(day("2026-08-01", 4)), {
      "2026-08-01": { total: 7, byAgent: {} },
    });
    expect(out.days[0].cost).toBe(4);
  });
});

describe("an empty report", () => {
  it("returns the series untouched, flags and all", () => {
    const s = series(day("2026-08-01", 4));
    expect(mergeEstimatedCost(s, {})).toBe(s);
  });
});

/**
 * The frame all three share. It drifted when it was written out three times —
 * three different seeds for a report-only day — so what it guarantees is that a
 * day the series never saw is built by the SAME merge as one it did.
 */
describe("overlayDays", () => {
  const base = series(day("2026-08-02", null));

  it("appends report-only days in date order", () => {
    const out = overlayDays(base, { "2026-08-01": 1, "2026-08-03": 1 }, (d) => d);
    expect(out.map((d) => d.date)).toEqual(["2026-08-01", "2026-08-02", "2026-08-03"]);
  });

  it("seeds an unseen day through the merge, not around it", () => {
    const out = overlayDays(base, { "2026-08-01": 7 }, (d, r) => ({ ...d, cost: r }));
    // Every field of an empty day, plus whatever the merge did — never a
    // hand-written literal that can diverge from the merged shape.
    expect(out[0]).toEqual({
      date: "2026-08-01",
      sessions: 0,
      messages: 0,
      tokens: 0,
      cost: 7,
      byAgent: {},
    });
  });

  it("leaves days the report says nothing about untouched", () => {
    const untouched = day("2026-08-02", 5);
    const out = overlayDays(series(untouched), {}, () => {
      throw new Error("merge must not run");
    });
    expect(out[0]).toBe(untouched);
  });
});

describe("mergeTokens", () => {
  const reads = new Set(["claude", "codex"]);
  const u = (agent, tokens) => ({
    input: tokens,
    output: 0,
    cacheCreate: 0,
    cacheRead: 0,
    total: tokens,
    agents: [
      { agent, tokens, input: tokens, output: 0, cacheCreate: 0, cacheRead: 0, total: tokens },
    ],
  });

  it("replaces our count with the reader's", () => {
    const s = series(day("2026-08-01", null, { claude: { tokens: 5, cost: null } }));
    const out = mergeTokens(s, { "2026-08-01": u("claude", 900) }, reads);
    expect(out.days[0].byAgent.claude.tokens).toBe(900);
    expect(out.days[0].tokens).toBe(900);
    expect(out.totals.tokens).toBe(900);
    expect(out.tokenSource).toBe("ccusage");
  });

  it("zeroes a supported agent it stayed silent about", () => {
    const s = series(day("2026-08-01", null, { claude: { tokens: 5 }, codex: { tokens: 7 } }));
    const out = mergeTokens(s, { "2026-08-01": u("claude", 900) }, reads);
    expect(out.days[0].byAgent.codex.tokens).toBe(0);
  });

  it("leaves an agent it cannot read alone — silence is not a zero", () => {
    const s = series(day("2026-08-01", null, { cursor: { tokens: 7 } }));
    const out = mergeTokens(s, { "2026-08-01": u("claude", 900) }, reads);
    expect(out.days[0].byAgent.cursor.tokens).toBe(7);
    // The headline is the sum of the rows, so the unreadable agent still counts.
    expect(out.days[0].tokens).toBe(907);
  });
});

describe("mergeBilledCost", () => {
  it("replaces the ledger's day rather than adding to it", () => {
    // The ledger saw one driven turn; the billing report saw the whole account.
    const s = series(day("2026-08-01", 19.02, { claude: { cost: 19.02 } }));
    const out = mergeBilledCost(s, { "2026-08-01": 553.73 });
    expect(out.days[0].cost).toBe(553.73);
    expect(out.totals.cost).toBe(553.73);
    expect(out.totals.costSource).toBe("admin-api");
    expect(out.totals.costComplete).toBe(true);
  });

  it("keeps days the report never covered", () => {
    const s = series(day("2026-08-01", 4), day("2026-08-02", 6));
    const out = mergeBilledCost(s, { "2026-08-01": 10 });
    expect(out.days.map((d) => d.cost)).toEqual([10, 6]);
  });

  it("does not invent a per-agent split from an org-wide figure", () => {
    const s = series(day("2026-08-01", 2, { claude: { cost: 2 } }));
    const out = mergeBilledCost(s, { "2026-08-01": 99 });
    expect(out.days[0].byAgent.claude.cost).toBe(2);
  });

  it("leaves an all-unknown window unknown rather than reporting $0.00", () => {
    const out = mergeBilledCost(series(day("2026-08-01", null)), {});
    expect(out.totals.cost).toBeNull();
  });
});
