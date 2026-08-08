/**
 * The run encoding the terminal dock renders from.
 *
 * Written against the real WASM emulator rather than a fake: the whole point of
 * this layer is that it agrees with a VT parser, and a stubbed one would only
 * prove this file agrees with itself. The flag and colour constants asserted
 * here were measured out of the same core (see screen.mjs FLAG).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { COLOR_DEFAULT, FLAG, Screen } from "./screen.mjs";

/** The emulator loads its WASM asynchronously and buffers writes until it's
 *  ready; a tick is enough (it loads in ~ms). */
const ready = () => new Promise((r) => setTimeout(r, 60));

/** Every run on a row, flattened — most assertions don't care about grouping. */
const runsOf = (frame, y) => frame.lines.find((l) => l.y === y)?.runs ?? [];
const textOf = (frame, y) =>
  runsOf(frame, y)
    .map((r) => r[0])
    .join("");

describe("Screen.cells", () => {
  /** @type {Screen} */
  let screen;
  beforeEach(async () => {
    screen = new Screen({ cols: 40, rows: 5 });
    await ready();
    screen.write("\x1b[2J\x1b[H");
  });

  it("coalesces cells that share every attribute into one run", () => {
    screen.write("plain text here");
    const runs = runsOf(screen.cells(), 0);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toEqual(["plain text here", COLOR_DEFAULT, COLOR_DEFAULT, 0]);
  });

  it("splits a run where colour or attributes change", () => {
    screen.write("a\x1b[1;31mB\x1b[0mc");
    const runs = runsOf(screen.cells(), 0);
    expect(runs[0]).toEqual(["a", COLOR_DEFAULT, COLOR_DEFAULT, 0]);
    // fg 1 is ANSI red; the flag is bold.
    expect(runs[1]).toEqual(["B", 1, COLOR_DEFAULT, FLAG.bold]);
    expect(runs[2]).toEqual(["c", COLOR_DEFAULT, COLOR_DEFAULT, 0]);
  });

  it("reports the default colour as 256, not as an index or -1", () => {
    // A client that reads the default as a palette index paints nothing, so
    // this constant is load-bearing rather than incidental.
    screen.write("x");
    expect(runsOf(screen.cells(), 0)[0][1]).toBe(COLOR_DEFAULT);
  });

  it("trims trailing blanks that share a run with real text", () => {
    // The row is 40 cells; "done" leaves 36 spaces behind it. Shipping those
    // is 36 wasted cells per row on every frame.
    screen.write("done");
    expect(textOf(screen.cells(), 0)).toBe("done");
  });

  it("keeps trailing blanks that are drawn on a coloured background", () => {
    // Spaces on a background are a drawn block — a selection bar, a TUI panel.
    // Trimming them punches a hole in the picture.
    screen.write("\x1b[44m    \x1b[0m");
    const runs = runsOf(screen.cells(), 0);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toEqual(["    ", COLOR_DEFAULT, 4, 0]);
  });

  it("returns an empty run list for a blank row rather than omitting it", () => {
    screen.write("top");
    const frame = screen.cells();
    // Rows 1-4 are blank but still present: the client indexes rows by `y`, and
    // a missing row would leave stale content painted there.
    expect(frame.lines.map((l) => l.y)).toEqual([0, 1, 2, 3, 4]);
    expect(runsOf(frame, 2)).toEqual([]);
  });

  it("dirtyOnly returns just the rows that changed, then clears them", () => {
    screen.write("first");
    screen.cells({ dirtyOnly: true }); // drain the initial paint
    screen.write("\x1b[3;1Hthird");
    const delta = screen.cells({ dirtyOnly: true });
    expect(delta.lines.map((l) => l.y)).toEqual([2]);
    expect(textOf(delta, 2)).toBe("third");
    // Nothing written since — the next read must be empty, or a client would
    // repaint identical rows forever.
    expect(screen.cells({ dirtyOnly: true }).lines).toEqual([]);
  });

  it("reports the cursor so the dock can draw it", () => {
    screen.write("abc");
    expect(screen.cells().cursor).toMatchObject({ row: 0, col: 3, visible: true });
  });

  it("hands back the reply to a query the program made", () => {
    // Device Status Report. Nobody but the emulator can answer this, and a
    // shell that asks and hears nothing can stall before printing a prompt.
    screen.write("\x1b[6n");
    expect(screen.takeResponse()).toMatch(/^\x1b\[\d+;\d+R$/u);
  });

  it("tracks the alternate screen and application cursor mode", () => {
    expect(screen.altScreen()).toBe(false);
    screen.write("\x1b[?1049h");
    expect(screen.altScreen()).toBe(true);
    expect(screen.cursorKeysApp()).toBe(false);
    screen.write("\x1b[?1h");
    expect(screen.cursorKeysApp()).toBe(true);
  });

  it("keeps lines() working for prompt detection", () => {
    // The generic interactive-prompt detector reads this, not cells().
    screen.write("\x1b[7mhighlighted\x1b[0m");
    const lines = screen.lines();
    expect(lines[0]).toEqual({ text: "highlighted", inverse: true });
  });
});
