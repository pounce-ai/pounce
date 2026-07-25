import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

// The ledger resolves ~/.pounce ONCE at module load, so the fake home has to
// exist before the import below — hence mkdtemp inside vi.hoisted rather than
// in a beforeEach. Keeps tests off the developer's real ~/.pounce/usage.jsonl.
const h = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const nodePath = require("node:path");
  return { home: mkdtempSync(nodePath.join(tmpdir(), "pounce-ledger-")) };
});
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    default: { ...actual.default, homedir: () => h.home },
    homedir: () => h.home,
  };
});

import { LEDGER_FILE, recordTurn, threadTotals } from "./cost-ledger.mjs";
import { noUsage, usageResult } from "./usage.mjs";

describe("usageResult", () => {
  it("totals tokens including cache reads and writes", () => {
    const u = usageResult({ tokens: { input: 10, output: 5, cacheRead: 100, cacheCreation: 20 } });
    expect(u.tokens.total).toBe(135);
    expect(u.available).toBe(true);
  });

  it("defaults missing token fields to zero rather than NaN", () => {
    const u = usageResult({ tokens: { input: undefined, output: null } });
    expect(u.tokens).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
      reasoning: 0,
      total: 0,
    });
  });

  it("keeps cost null rather than coercing it to zero", () => {
    // "not knowable" and "genuinely free" are different answers and the UI
    // renders them differently — null must survive.
    const u = usageResult({ tokens: { input: 1 }, cost: null });
    expect(u.cost).toBeNull();
    expect(u.costSource).toBeNull();
  });

  it("preserves a real zero cost reported by the agent", () => {
    const u = usageResult({ tokens: { input: 1 }, cost: 0, costSource: "agent" });
    expect(u.cost).toBe(0);
    expect(u.costSource).toBe("agent");
  });

  it("carries plan rate-limit data for agents that bill against a plan", () => {
    const rateLimit = { usedPercent: 26, windowMinutes: 300, resetsAt: 1, planType: "plus" };
    expect(usageResult({ tokens: {}, cost: null, rateLimit }).rateLimit).toEqual(rateLimit);
  });

  it("reports unavailability with a reason", () => {
    expect(noUsage("no-transcript")).toEqual({ available: false, reason: "no-transcript" });
  });
});

describe("cost-ledger", () => {
  // One fake home for the suite (see the hoisted mock); truncate between tests
  // so each starts from an empty ledger.
  beforeEach(() => {
    mkdirSync(path.dirname(LEDGER_FILE), { recursive: true });
    writeFileSync(LEDGER_FILE, "");
  });
  afterAll(() => {
    rmSync(h.home, { recursive: true, force: true });
  });

  const row = (over = {}) => ({
    agent: "claude",
    threadId: "t1",
    costUsd: 0.25,
    tokens: { input: 10, output: 5, cacheRead: 100, cacheCreation: 20 },
    ...over,
  });

  it("returns null for a thread with no recorded turns", async () => {
    // Distinct from a $0 total: we never drove a turn, so cost is unknowable.
    expect(await threadTotals("claude", "never-seen")).toBeNull();
  });

  it("accumulates cost and tokens across turns of one thread", async () => {
    recordTurn(row());
    recordTurn(row({ costUsd: 0.75 }));
    const t = await threadTotals("claude", "t1");
    expect(t.rows).toBe(2);
    expect(t.cost).toBeCloseTo(1.0, 10);
    expect(t.tokens).toEqual({
      input: 20,
      output: 10,
      cacheRead: 200,
      cacheCreation: 40,
      reasoning: 0,
    });
    expect(t.costComplete).toBe(true);
  });

  it("keeps threads and agents separate", async () => {
    recordTurn(row());
    recordTurn(row({ threadId: "t2", costUsd: 9 }));
    recordTurn(row({ agent: "codex", costUsd: 9 }));
    expect((await threadTotals("claude", "t1")).cost).toBeCloseTo(0.25, 10);
    expect((await threadTotals("claude", "t2")).cost).toBeCloseTo(9, 10);
  });

  it("flags a total as incomplete when some turns reported no cost", async () => {
    recordTurn(row());
    recordTurn(row({ costUsd: null }));
    const t = await threadTotals("claude", "t1");
    expect(t.costComplete).toBe(false);
    expect(t.cost).toBeCloseTo(0.25, 10);
  });

  it("reports null cost when no turn reported dollars", async () => {
    recordTurn(row({ costUsd: null }));
    recordTurn(row({ costUsd: undefined }));
    const t = await threadTotals("claude", "t1");
    expect(t.rows).toBe(2);
    expect(t.cost).toBeNull();
  });

  it("keeps the newest model and context window", async () => {
    recordTurn(row({ model: "claude-sonnet-5", contextWindow: 200000 }));
    recordTurn(row({ model: "claude-opus-5[1m]", contextWindow: 1000000 }));
    const t = await threadTotals("claude", "t1");
    expect(t.model).toBe("claude-opus-5[1m]");
    expect(t.contextWindow).toBe(1000000);
  });

  it("ignores rows missing an agent or thread id", async () => {
    recordTurn({ costUsd: 5 });
    recordTurn({ agent: "claude", costUsd: 5 });
    expect(await threadTotals("claude", "t1")).toBeNull();
  });

  it("survives a malformed line in the ledger", async () => {
    const { appendFileSync } = await import("node:fs");
    recordTurn(row());
    appendFileSync(LEDGER_FILE, "not json\n");
    recordTurn(row());
    expect((await threadTotals("claude", "t1")).rows).toBe(2);
  });
});
