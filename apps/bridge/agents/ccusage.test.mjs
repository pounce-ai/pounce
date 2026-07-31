/**
 * The fixtures below are trimmed copies of real `ccusage --json` output (v20),
 * not invented shapes — the contract is a CLI's stdout, so a test written
 * against an imagined payload would prove nothing.
 */
import { describe, expect, it } from "vitest";
import { parseDaily, parseSession } from "./ccusage.mjs";

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
