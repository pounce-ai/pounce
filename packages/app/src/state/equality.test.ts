/**
 * `deepEqual` decides two things that both fail quietly when it is wrong: which
 * rows the sync writes (see db/rowWrites) and which derived props keep their
 * identity (see `useStable`). Too loose and a real change is dropped; too tight
 * and every tick re-renders the screen it was meant to spare.
 */
import { describe, expect, it } from "vitest";
import { deepEqual } from "./equality";

describe("deepEqual", () => {
  it("compares primitives without coercing", () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual("a", "a")).toBe(true);
    expect(deepEqual(0, false)).toBe(false);
    expect(deepEqual("", 0)).toBe(false);
    expect(deepEqual(null, undefined)).toBe(false);
    expect(deepEqual(Number.NaN, Number.NaN)).toBe(false); // matches ===, as callers expect
  });

  it("compares nested objects by value", () => {
    expect(deepEqual({ a: { b: [1, 2] } }, { a: { b: [1, 2] } })).toBe(true);
    expect(deepEqual({ a: { b: [1, 2] } }, { a: { b: [1, 3] } })).toBe(false);
  });

  it("is sensitive to key count in both directions", () => {
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEqual({ a: 1, b: 2 }, { a: 1 })).toBe(false);
  });

  it("does not treat a missing key as equal to an undefined one", () => {
    // Same key count, different keys — the loop must check presence, not just
    // read through to undefined on both sides.
    expect(deepEqual({ a: undefined }, { b: undefined })).toBe(false);
  });

  it("distinguishes arrays from objects, and respects order and length", () => {
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
    expect(deepEqual([1], [1, undefined])).toBe(false);
    expect(deepEqual([], {})).toBe(false);
  });

  it("treats non-plain objects as unequal rather than guessing", () => {
    // Bailing out is deliberate: an unrecognised shape must behave as "changed",
    // so the caller does what it did before this function existed.
    const d = new Date(0);
    expect(deepEqual(d, new Date(0))).toBe(false);
    expect(deepEqual(new Set([1]), new Set([1]))).toBe(false);
    expect(deepEqual(new Map(), new Map())).toBe(false);
    // ...but the identical reference is still equal, via the fast path.
    expect(deepEqual(d, d)).toBe(true);
  });

  it("handles the shapes the sync actually sends", () => {
    const row = {
      id: "t1",
      title: "Explore",
      usage: { tokens: 10, cacheRead: 0 },
      tags: ["a", "b"],
      branch: null,
    };
    expect(deepEqual(row, structuredClone(row))).toBe(true);
    expect(deepEqual(row, { ...row, branch: "main" })).toBe(false);
    expect(deepEqual(row, { ...row, usage: { tokens: 11, cacheRead: 0 } })).toBe(false);
  });
});
