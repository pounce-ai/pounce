import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createActivityIndex } from "./activity-index.mjs";

/**
 * The token arithmetic, pinned.
 *
 * This is the part that went wrong quietly: the dashboard reported 327B where
 * Codex's own profile said 25.1B, because cache reads were counted as work and
 * repeated `token_count` events were counted twice. Both are invisible in the
 * UI — a big number looks like a big number — so they get tests.
 */

const dirs = [];
function workspace() {
  const d = mkdtempSync(path.join(tmpdir(), "pounce-activity-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

/** An index over one fake transcript, with its cache confined to the temp dir. */
function indexOver(dir, agent, lines) {
  const file = path.join(dir, `${agent}.jsonl`);
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return createActivityIndex({
    resolveFile: async () => file,
    cacheFile: path.join(dir, "cache.json"),
    ledgerFile: path.join(dir, "ledger.jsonl"),
  });
}

const codexEvent = (ts, last, cumulative) => ({
  type: "event_msg",
  timestamp: ts,
  payload: { type: "token_count", info: { last_token_usage: last, total_token_usage: cumulative } },
});

const usage = (input, cached, output) => ({
  input_tokens: input,
  cached_input_tokens: cached,
  output_tokens: output,
  total_tokens: input + output,
});

describe("token accounting", () => {
  it("excludes Claude's cache reads but keeps cache creation", async () => {
    const dir = workspace();
    const idx = indexOver(dir, "claude", [
      {
        type: "assistant",
        timestamp: "2026-07-01T10:00:00Z",
        message: {
          model: "claude-opus-5",
          usage: {
            input_tokens: 1_000,
            output_tokens: 500,
            cache_creation_input_tokens: 2_000,
            cache_read_input_tokens: 90_000, // re-reading context is not new work
          },
        },
      },
    ]);
    const days = await idx.threadDays("claude", "t1");
    expect(days["2026-07-01"].tokens).toBe(3_500); // 1000 + 500 + 2000, cache read dropped
  });

  it("ignores Claude's synthetic turns, which made no API call", async () => {
    const dir = workspace();
    const idx = indexOver(dir, "claude", [
      {
        type: "assistant",
        timestamp: "2026-07-01T10:00:00Z",
        message: { model: "<synthetic>", usage: { input_tokens: 999, output_tokens: 999 } },
      },
    ]);
    expect(await idx.threadDays("claude", "t1")).toEqual({});
  });

  it("counts Codex requests once and drops the cached portion", async () => {
    const dir = workspace();
    // Two real requests. Each re-sends the conversation, most of it cached.
    const idx = indexOver(dir, "codex", [
      codexEvent("2026-07-01T10:00:00Z", usage(10_000, 9_000, 100), { total_tokens: 10_100 }),
      codexEvent("2026-07-01T10:01:00Z", usage(20_000, 19_000, 200), { total_tokens: 30_300 }),
    ]);
    const days = await idx.threadDays("codex", "t1");
    // fresh = (10100 - 9000) + (20200 - 19000)
    expect(days["2026-07-01"].tokens).toBe(1_100 + 1_200);
    expect(days["2026-07-01"].messages).toBe(2);
  });

  it("does not count a repeated token_count event", async () => {
    const dir = workspace();
    const idx = indexOver(dir, "codex", [
      codexEvent("2026-07-01T10:00:00Z", usage(10_000, 9_000, 100), { total_tokens: 10_100 }),
      // Codex re-emits the same event; the cumulative does not move.
      codexEvent("2026-07-01T10:00:30Z", usage(10_000, 9_000, 100), { total_tokens: 10_100 }),
    ]);
    const days = await idx.threadDays("codex", "t1");
    expect(days["2026-07-01"].tokens).toBe(1_100); // once, not twice
    expect(days["2026-07-01"].messages).toBe(1);
  });

  it("keeps counting after a compaction rebases the cumulative", async () => {
    const dir = workspace();
    const idx = indexOver(dir, "codex", [
      codexEvent("2026-07-01T10:00:00Z", usage(50_000, 40_000, 500), { total_tokens: 50_500 }),
      // Session compacts: the cumulative restarts well below where it was.
      codexEvent("2026-07-01T11:00:00Z", usage(5_000, 4_000, 100), { total_tokens: 5_100 }),
      codexEvent("2026-07-01T11:01:00Z", usage(6_000, 5_000, 100), { total_tokens: 11_200 }),
    ]);
    const days = await idx.threadDays("codex", "t1");
    // 10500 + 1100 + 1100 — the rebase is not mistaken for a duplicate.
    expect(days["2026-07-01"].tokens).toBe(10_500 + 1_100 + 1_100);
    expect(days["2026-07-01"].messages).toBe(3);
  });

  it("buckets by the event's own UTC day", async () => {
    const dir = workspace();
    const idx = indexOver(dir, "codex", [
      codexEvent("2026-07-01T23:59:00Z", usage(1_000, 0, 0), { total_tokens: 1_000 }),
      codexEvent("2026-07-02T00:01:00Z", usage(2_000, 0, 0), { total_tokens: 3_000 }),
    ]);
    const days = await idx.threadDays("codex", "t1");
    expect(days["2026-07-01"].tokens).toBe(1_000);
    expect(days["2026-07-02"].tokens).toBe(2_000);
  });

  it("reports nothing for agents whose transcripts carry no dated usage", async () => {
    const dir = workspace();
    const idx = indexOver(dir, "opencode", [{ type: "whatever" }]);
    expect(await idx.threadDays("opencode", "t1")).toEqual({});
  });
});
