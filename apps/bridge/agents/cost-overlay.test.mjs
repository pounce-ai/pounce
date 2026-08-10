/**
 * What the estimate is allowed to overwrite.
 *
 * The rule these pin is a coverage rule, not a precedence rule: the ledger sees
 * only the turns Pounce drove, the report sees every transcript, and getting
 * that backwards costs real money on the dashboard without breaking anything.
 */
import { describe, expect, it } from "vitest";
import { mergeEstimatedCost } from "./cost-overlay.mjs";

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
