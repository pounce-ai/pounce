import { describe, expect, it } from "vitest";
import { BLOCK_HOURS, foldBlocks } from "./blocks.mjs";

const MIN = 60_000;
const HOUR = 60 * MIN;
const BLOCK = BLOCK_HOURS * HOUR;
const at = (ms, tokens) => ({ ms, tokens });

describe("foldBlocks", () => {
  it("opens a window at the first sample, not on a clock boundary", () => {
    // 14:37, deliberately not on the hour: Claude's window starts when you do.
    const start = Date.parse("2026-07-30T14:37:00Z");
    const [b] = foldBlocks([at(start, 10), at(start + 30 * MIN, 5)]);
    expect(b.startedMs).toBe(start);
    expect(b.tokens).toBe(15);
    expect(b.messages).toBe(2);
  });

  it("keeps samples inside the window together", () => {
    const start = Date.parse("2026-07-30T09:00:00Z");
    const blocks = foldBlocks([
      at(start, 1),
      at(start + BLOCK - MIN, 2), // one minute inside the edge
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].tokens).toBe(3);
  });

  it("starts a new window at the edge, not before it", () => {
    const start = Date.parse("2026-07-30T09:00:00Z");
    const blocks = foldBlocks([at(start, 1), at(start + BLOCK, 2)]);
    expect(blocks).toHaveLength(2);
    expect(blocks[1].startedMs).toBe(start + BLOCK);
    expect(blocks[1].tokens).toBe(2);
  });

  it("measures the next window from ITS first sample, not the previous edge", () => {
    // The gap matters: a 9-hour pause means window two opens at hour nine, so a
    // sample at hour 13 still belongs to it. Bucketing by fixed 5h offsets from
    // the first message would wrongly split these.
    const start = Date.parse("2026-07-30T00:00:00Z");
    const blocks = foldBlocks([at(start, 1), at(start + 9 * HOUR, 2), at(start + 13 * HOUR, 4)]);
    expect(blocks).toHaveLength(2);
    expect(blocks[1].startedMs).toBe(start + 9 * HOUR);
    expect(blocks[1].tokens).toBe(6);
  });

  it("sorts before folding, so threads read concurrently still group correctly", () => {
    const start = Date.parse("2026-07-30T09:00:00Z");
    const blocks = foldBlocks([at(start + 20 * MIN, 2), at(start, 1), at(start + 10 * MIN, 3)]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].startedMs).toBe(start);
    expect(blocks[0].tokens).toBe(6);
  });

  it("has no windows without samples", () => {
    expect(foldBlocks([])).toEqual([]);
  });
});
