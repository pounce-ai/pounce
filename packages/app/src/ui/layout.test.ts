/**
 * The reported bug, twice over: on a 1920pt display the Activity column sat at
 * its 1120pt cap with ~290pt of dead gutter each side, and the sidebar stayed
 * at the 264pt it was given on a laptop.
 */
import { describe, expect, it } from "vitest";
import { scaledWidth } from "./layout";

// Copies of the shipped bounds, not imports: the real ones live beside their
// call sites in Dashboard.tsx and metrics.ts, and importing either would pull
// react-native into a plain unit test. These pin the SHAPE of the rule — the
// numbers are asserted relatively (floor holds, cap holds, a laptop is left
// alone) so this stays honest if a policy is retuned.
const CONTENT = { fraction: 0.86, min: 1120, max: 1600 };
const SIDEBAR = { fraction: 0.18, min: 264, max: 460 };

describe("growing with the window", () => {
  it("gives a large display more than the old fixed number did", () => {
    expect(scaledWidth(1920, CONTENT)).toBeGreaterThan(CONTENT.min);
    expect(scaledWidth(1920, SIDEBAR)).toBeGreaterThan(SIDEBAR.min);
  });

  it("leaves a laptop exactly where it was", () => {
    // The floor is the width these columns shipped with, so nobody on a small
    // window wakes up to a narrower app than they had.
    expect(scaledWidth(1280, CONTENT)).toBe(CONTENT.min);
    expect(scaledWidth(1280, SIDEBAR)).toBe(SIDEBAR.min);
  });

  it("stops growing before an ultrawide becomes unreadable", () => {
    expect(scaledWidth(5120, CONTENT)).toBe(CONTENT.max);
    expect(scaledWidth(5120, SIDEBAR)).toBe(SIDEBAR.max);
  });

  it("still leaves a margin at the size that prompted this", () => {
    // Not the whole window: content run edge to edge is the other complaint.
    expect(scaledWidth(1920, CONTENT)).toBeLessThan(1920);
  });
});

describe("before the first layout", () => {
  it("reports the floor rather than a fraction of nothing", () => {
    // A zero here is "not measured yet", not "no room" — sizing to it would
    // flash the column at its minimum on every mount.
    expect(scaledWidth(0, CONTENT)).toBe(CONTENT.min);
    expect(scaledWidth(-1, SIDEBAR)).toBe(SIDEBAR.min);
    expect(scaledWidth(Number.NaN, SIDEBAR)).toBe(SIDEBAR.min);
  });
});

describe("the returned width", () => {
  it("is a whole number, so a layout never lands on a half point", () => {
    expect(scaledWidth(1777, CONTENT)).toBe(Math.round(1777 * CONTENT.fraction));
    expect(Number.isInteger(scaledWidth(1777, SIDEBAR))).toBe(true);
  });
});
