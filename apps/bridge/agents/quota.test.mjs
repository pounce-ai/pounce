/**
 * opencode Go's plan meter — the one reading in quota.mjs that leaves the
 * machine.
 *
 * What matters here isn't the happy path so much as the failures: this is a
 * live third-party call sitting behind a dashboard card, and every way it can
 * go wrong must still leave the card saying something true. A dropped card
 * reads as "that agent isn't in use", which is a different claim entirely.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mapClaudeUsage, readOpencodeQuota, resetQuotaCache } from "./quota.mjs";

/** A stand-in for opencode's usage endpoint. */
const responder = (status, body) =>
  vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }));

const OK = {
  usage: {
    rolling: { status: "ok", percent: 12, resetsAt: "2026-08-13T20:07:41.567Z" },
    weekly: { status: "ok", percent: 44, resetsAt: "2026-08-17T00:00:00.567Z" },
    monthly: { status: "ok", percent: 22, resetsAt: "2026-09-05T19:41:06.567Z" },
  },
};

beforeEach(() => resetQuotaCache());

describe("readOpencodeQuota", () => {
  it("turns the three percentages into rendered windows", async () => {
    const fetchImpl = responder(200, OK);
    const q = await readOpencodeQuota({ fetchImpl, key: "sk-test" });
    expect(q.planType).toBe("Go");
    expect(q.windows.map((w) => [w.label, w.usedPercent])).toEqual([
      ["Rolling", 12],
      ["Weekly", 44],
      ["Monthly", 22],
    ]);
    expect(q.windows[1].resetsAt).toBe("2026-08-17T00:00:00.567Z");
    // Read just now, so the card can never dim it as stale.
    expect(Date.parse(q.observedAt)).toBeGreaterThan(Date.now() - 5000);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://opencode.ai/zen/go/v1/usage");
    expect(init.headers.authorization).toBe("Bearer sk-test");
  });

  it("drops a window the service can't currently speak for, rather than showing 0%", async () => {
    const q = await readOpencodeQuota({
      key: "sk-test",
      fetchImpl: responder(200, {
        usage: { ...OK.usage, rolling: { status: "unavailable", percent: 0 } },
      }),
    });
    expect(q.windows.map((w) => w.label)).toEqual(["Weekly", "Monthly"]);
  });

  it("keeps the plan and says why when the key isn't a Go seat", async () => {
    const q = await readOpencodeQuota({ key: "sk-test", fetchImpl: responder(403, {}) });
    expect(q).toMatchObject({ planType: "Go", note: "no Go plan on this key" });
    expect(q.windows).toBeUndefined();
  });

  it("keeps the plan and says why when opencode is unreachable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ENOTFOUND");
    });
    const q = await readOpencodeQuota({ key: "sk-test", fetchImpl });
    expect(q).toMatchObject({ planType: "Go", note: "couldn't reach opencode just now" });
  });

  it("asks once per minute, however often the dashboard paints", async () => {
    const fetchImpl = responder(200, OK);
    await readOpencodeQuota({ fetchImpl, key: "sk-test" });
    await readOpencodeQuota({ fetchImpl, key: "sk-test" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  // Whether this machine has a bare (pay-as-you-go) opencode key decides
  // between `null` and a "no plan window" note; either way there is nothing to
  // meter, and nothing to ask opencode.
  it("never calls out when there is no Go key", async () => {
    const fetchImpl = responder(200, OK);
    const q = await readOpencodeQuota({ fetchImpl, key: null });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(q?.windows).toBeUndefined();
  });
});

/**
 * Claude's meter comes from an UNDOCUMENTED endpoint (the one its own `/usage`
 * view calls), so the mapping is the part most likely to be wrong tomorrow.
 * These pin the two things that must survive a shape change: a window we can't
 * read is dropped rather than shown as 0%, and nothing here throws.
 */
describe("mapClaudeUsage", () => {
  /** The real payload, recorded from the endpoint on 2026-08-13. */
  const LIVE = {
    five_hour: { utilization: 19, resets_at: "2026-08-13T19:59:59Z", limit_dollars: 1 },
    seven_day: { utilization: 58, resets_at: "2026-08-14T04:59:59Z" },
    seven_day_opus: {},
    nimbus_quill: { utilization: 13, resets_at: "2026-08-14T04:59:59Z" },
    extra_usage: { is_enabled: false, utilization: 0, used_credits: 0 },
    spend: { used: 0, limit: 0, percent: 42, severity: "normal" },
    limits: [
      {
        kind: "session",
        group: "session",
        percent: 19,
        resets_at: "2026-08-13T19:59:59Z",
        scope: null,
      },
      {
        kind: "weekly_all",
        group: "weekly",
        percent: 58,
        resets_at: "2026-08-14T04:59:59Z",
        scope: null,
      },
      {
        kind: "weekly_scoped",
        group: "weekly",
        percent: 13,
        resets_at: "2026-08-14T04:59:59Z",
        scope: { model: { id: null, display_name: "Fable" }, surface: null },
      },
    ],
  };

  it("reads `limits`, and nothing else in the payload", () => {
    // The point of the test: `spend.percent` is DOLLARS and `extra_usage`
    // is a credit balance. Both used to render as rate-limit bars.
    expect(mapClaudeUsage(LIVE)).toEqual([
      { label: "Session", usedPercent: 19, windowMinutes: null, resetsAt: "2026-08-13T19:59:59Z" },
      { label: "Weekly", usedPercent: 58, windowMinutes: null, resetsAt: "2026-08-14T04:59:59Z" },
      {
        label: "Weekly · Fable",
        usedPercent: 13,
        windowMinutes: null,
        resetsAt: "2026-08-14T04:59:59Z",
      },
    ]);
  });

  it("names the seven-day window Weekly, not Session", () => {
    // `kind` spells the duration, so matching the key for the word "week" is
    // what mislabelled it the first time round.
    const w = mapClaudeUsage({ limits: [{ kind: "weekly_all", percent: 5 }] });
    expect(w[0].label).toBe("Weekly");
  });

  it("falls back to the top-level durations when there is no `limits`", () => {
    const w = mapClaudeUsage({ five_hour: LIVE.five_hour, seven_day: LIVE.seven_day });
    expect(w.map((x) => [x.label, x.usedPercent])).toEqual([
      ["Session", 19],
      ["Weekly", 58],
    ]);
  });

  it("drops what it cannot read instead of reporting zero", () => {
    expect(mapClaudeUsage({ limits: [{ kind: "session", resets_at: "x" }] })).toEqual([]);
    expect(mapClaudeUsage(null)).toEqual([]);
    expect(mapClaudeUsage("nonsense")).toEqual([]);
  });
});
