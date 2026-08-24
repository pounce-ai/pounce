/**
 * The fixtures below are trimmed copies of real `ccusage --json` output (v20),
 * not invented shapes — the contract is a CLI's stdout, so a test written
 * against an imagined payload would prove nothing.
 */
import { describe, expect, it } from "vitest";
import { parseDaily, parseDailyUsage, parseSession } from "./ccusage.mjs";

const ID = "57ffa931-fb3b-43a9-8b07-4a55c7efec62";

/** `ccusage session --json -i <id>`: note costUSD is 0 on every entry while the
 *  top-level totalCost is real — that asymmetry is the point of this fixture. */
const sessionPayload = {
  sessionId: ID,
  totalCost: 7.530952000000001,
  totalTokens: 8182971,
  entries: [
    { model: "claude-opus-5", costUSD: 0, inputTokens: 2, outputTokens: 538 },
    { model: "claude-opus-5", costUSD: 0, inputTokens: 2, outputTokens: 351 },
  ],
};

describe("parseSession", () => {
  it("takes the top-level total, not the per-entry costUSD column", () => {
    // Summing entries[].costUSD would report $0.00 for a $7.53 thread: that
    // column is the agent's own recorded cost, which Claude never writes.
    expect(parseSession(sessionPayload, ID)).toEqual({
      cost: 7.530952000000001,
      models: ["claude-opus-5"],
    });
  });

  it("refuses a payload whose sessionId isn't the thread asked about", () => {
    expect(parseSession(sessionPayload, "some-other-thread")).toBeNull();
  });

  it("returns null for an unknown id — ccusage answers `null`, not an error", () => {
    expect(parseSession(null, "nope")).toBeNull();
  });

  it("treats a zero cost on a thread with real tokens as unpriced, not free", () => {
    // This is what `--offline` (and any pricing failure) actually produces: the
    // tokens are real, the dollars just never resolved. Reporting $0.00 here
    // would be a confident lie about a thread that cost money.
    const json = { sessionId: "t1", totalCost: 0, totalTokens: 1_000_000, entries: [] };
    expect(parseSession(json, "t1")).toBeNull();
  });
});

describe("parseDaily", () => {
  const payload = {
    daily: [
      {
        period: "2026-07-29",
        totalCost: 8.4004394,
        totalTokens: 14071047,
        agents: [{ agent: "claude", totalCost: 8.4004394, totalTokens: 14071047 }],
      },
      {
        period: "2026-07-30",
        totalCost: 33.2,
        totalTokens: 39323294,
        agents: [
          { agent: "claude", totalCost: 32.8, totalTokens: 39000000 },
          { agent: "opencode", totalCost: 0.4, totalTokens: 323294 },
        ],
      },
    ],
  };

  it("keys days by date with a per-agent breakdown", () => {
    expect(parseDaily(payload)).toEqual({
      "2026-07-29": { total: 8.4004394, byAgent: { claude: 8.4004394 } },
      "2026-07-30": { total: 33.2, byAgent: { claude: 32.8, opencode: 0.4 } },
    });
  });

  it("omits unpriced days entirely so callers can tell them from free ones", () => {
    const json = {
      daily: [{ period: "2026-07-30", totalCost: 0, totalTokens: 500, agents: [] }],
    };
    expect(parseDaily(json)).toEqual({});
  });

  it("omits an unpriced agent while keeping the day's priced ones", () => {
    const json = {
      daily: [
        {
          period: "2026-07-30",
          totalCost: 5,
          totalTokens: 100,
          agents: [
            { agent: "claude", totalCost: 5, totalTokens: 90 },
            { agent: "codex", totalCost: 0, totalTokens: 10 },
          ],
        },
      ],
    };
    expect(parseDaily(json)).toEqual({ "2026-07-30": { total: 5, byAgent: { claude: 5 } } });
  });

  it("survives junk rows rather than throwing into the dashboard", () => {
    const json = { daily: [null, { period: "not-a-date", totalCost: 9 }, { totalCost: 9 }] };
    expect(parseDaily(json)).toEqual({});
    expect(parseDaily(null)).toEqual({});
  });
});

/**
 * The token figures, pinned.
 *
 * The headline is the agent's REPORTED TOTAL, deliberately not a derived one:
 * a dashboard that subtracts cache reads shows a number no other tool reports
 * and then has to explain why it differs from the agent's own profile page.
 * The cached portion is carried separately so the UI can show the split.
 *
 * Both halves are invisible when broken — a big number looks like a big
 * number — so they get tests.
 */
describe("parseDailyUsage", () => {
  /** Real `daily --json --by-agent` output for 2026-07-25, whole. Every model
   *  is kept because their four columns sum exactly to the day's — trimming any
   *  of them would make the fixture stop adding up, which is the property the
   *  detail view depends on. 99.1% of that day's total was re-read context. */
  const payload = {
    daily: [
      {
        period: "2026-07-25",
        agent: "all",
        inputTokens: 1941,
        outputTokens: 442908,
        cacheCreationTokens: 3017893,
        cacheReadTokens: 379245020,
        totalTokens: 382707762,
        totalCost: 153.74491010000003,
        agents: [
          {
            agent: "claude",
            inputTokens: 1941,
            outputTokens: 442908,
            cacheCreationTokens: 3017893,
            cacheReadTokens: 379245020,
            totalTokens: 382707762,
            totalCost: 153.74491010000003,
            modelBreakdowns: [
              {
                modelName: "claude-opus-5",
                inputTokens: 1014,
                outputTokens: 321471,
                cacheCreationTokens: 1214922,
                cacheReadTokens: 149122012,
                cost: 94.75207099999996,
              },
              {
                modelName: "claude-sonnet-5",
                inputTokens: 901,
                outputTokens: 119199,
                cacheCreationTokens: 1519455,
                cacheReadTokens: 229765323,
                cost: 53.22467660000001,
              },
              {
                modelName: "claude-fable-5",
                inputTokens: 2,
                outputTokens: 295,
                cacheCreationTokens: 268049,
                cacheReadTokens: 20410,
                cost: 5.396160000000001,
              },
              {
                modelName: "claude-opus-4-8",
                inputTokens: 24,
                outputTokens: 1943,
                cacheCreationTokens: 15467,
                cacheReadTokens: 337275,
                cost: 0.3720025,
              },
            ],
          },
        ],
      },
    ],
  };

  it("reports the agent's own total, undiminished", () => {
    const day = parseDailyUsage(payload)["2026-07-25"];
    // Not 3,462,742 (total minus cache reads) — that figure appears on no
    // agent's profile page, so the dashboard would have to defend it.
    expect(day.tokens).toBe(382_707_762);
    expect(day.total).toBe(382_707_762);
  });

  it("carries the cached portion separately, for the subscript", () => {
    const day = parseDailyUsage(payload)["2026-07-25"];
    // 99.1% of that day. Shown beside the headline, never subtracted from it.
    expect(day.cacheRead).toBe(379_245_020);
    expect(day.cacheRead).toBeLessThan(day.total);
  });

  it("keeps the day's model rows summing to the day's headline", () => {
    // The detail view has to add up to the card it opened from, or one of them
    // is lying.
    const day = parseDailyUsage(payload)["2026-07-25"];
    const models = day.agents.flatMap((a) => a.models);
    expect(models.reduce((n, m) => n + m.tokens, 0)).toBe(day.tokens);
    expect(day.agents.reduce((n, a) => n + a.tokens, 0)).toBe(day.tokens);
  });

  it("orders agents and models by size, so the biggest reads first", () => {
    const day = parseDailyUsage(payload)["2026-07-25"];
    // By total: sonnet 231.4M, opus-5 150.7M, opus-4-8 354,709, fable 288,756.
    // Note this differs from the order by COST — fable is the priciest of the
    // four — which is exactly why the spend view sorts on dollars instead.
    expect(day.agents[0].models.map((m) => m.model)).toEqual([
      "claude-sonnet-5",
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-fable-5",
    ]);
  });

  it("keeps a day it could not price, unlike the cost-only reader", () => {
    // An unpriced day is still a real day of work; `cost: null` says the
    // dollars are unknown without discarding the tokens.
    const json = {
      daily: [
        { period: "2026-07-30", totalCost: 0, totalTokens: 500, cacheReadTokens: 100, agents: [] },
      ],
    };
    const day = parseDailyUsage(json)["2026-07-30"];
    expect(day.tokens).toBe(500);
    expect(day.cost).toBeNull();
  });

  it("leaves the headline alone even if cacheRead outruns the total", () => {
    // A malformed row can't distort the reported total, because nothing is
    // subtracted from it — the failure mode the old arithmetic had to guard.
    const json = {
      daily: [{ period: "2026-07-30", totalTokens: 100, cacheReadTokens: 999, agents: [] }],
    };
    expect(parseDailyUsage(json)["2026-07-30"].tokens).toBe(100);
  });

  it("survives junk rows rather than throwing into the dashboard", () => {
    expect(parseDailyUsage(null)).toEqual({});
    expect(parseDailyUsage({ daily: [null, { period: "nope", totalTokens: 5 }] })).toEqual({});
  });
});
