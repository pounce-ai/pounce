/**
 * Per-thread usage from a Claude transcript — specifically `lastModel`, which
 * answers a different question from `model`.
 *
 * `model` is the thread's dominant model by output tokens; `lastModel` is what
 * its newest turn actually ran on. The distinction only matters when a thread
 * MOVES — an agent-side fallback, or someone typing /model in a terminal on the
 * host — and that is exactly the case the app has to notice, because its sticky
 * per-thread selection is also what the next turn gets sent with.
 */
import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ClaudeAdapter } from "./claude.mjs";

const dirs = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

/** An assistant record: `out` output tokens on `model` at `timestamp`. */
const said = (model, out, timestamp, extra = {}) => ({
  type: "assistant",
  timestamp,
  message: { model, usage: { input_tokens: 1, output_tokens: out } },
  ...extra,
});

async function usageOf(records) {
  const dir = mkdtempSync(path.join(tmpdir(), "claude-usage-"));
  dirs.push(dir);
  const file = path.join(dir, "t.jsonl");
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n"));
  const a = new ClaudeAdapter({ turns: { isRunning: () => false } });
  a.findFile = async () => file;
  return a.getUsage("t");
}

describe("claude getUsage — lastModel", () => {
  it("reports where a thread ENDED UP, not where it spent most of its tokens", async () => {
    const u = await usageOf([
      said("claude-opus-5", 1000, "2026-08-20T10:00:00.000Z"),
      said("claude-sonnet-5", 10, "2026-08-20T11:00:00.000Z"),
    ]);
    expect(u.model).toBe("claude-opus-5"); // dominant, by output tokens
    expect(u.lastModel).toBe("claude-sonnet-5"); // and yet this is what it runs on now
    expect(u.lastModelAt).toBe("2026-08-20T11:00:00.000Z");
  });

  it("ignores subagents, which run on their own model without moving the thread", async () => {
    const u = await usageOf([
      said("claude-opus-5", 100, "2026-08-20T10:00:00.000Z"),
      said("claude-haiku-4-5", 5, "2026-08-20T10:30:00.000Z", { isSidechain: true }),
    ]);
    expect(u.lastModel).toBe("claude-opus-5");
  });

  it("ignores <synthetic>, which is Claude Code talking, not a model", async () => {
    const u = await usageOf([
      said("claude-opus-5", 100, "2026-08-20T10:00:00.000Z"),
      said("<synthetic>", 0, "2026-08-20T10:05:00.000Z"),
    ]);
    expect(u.lastModel).toBe("claude-opus-5");
    expect(u.models).not.toContain("<synthetic>");
  });

  it("says nothing at all for a transcript with no usage to read", async () => {
    const u = await usageOf([{ type: "user", message: { content: "hi" } }]);
    expect(u.available).toBe(false);
  });
});
