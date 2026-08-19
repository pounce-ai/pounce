import { describe, expect, it } from "vitest";
import { createPairCodes } from "./pair-codes.mjs";

/** A clock the test drives, so TTL behaviour is asserted rather than waited on. */
function fakeClock(start = 1000) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

describe("one-time pairing codes", () => {
  it("mints a high-entropy code", () => {
    const codes = createPairCodes();
    expect(codes.current().code).toMatch(/^[0-9a-f]{32}$/);
  });

  it("keeps the same code across renders until it is spent or expires", () => {
    // /ui polls and re-renders /qr.svg on a timer; a code that rotated per
    // render would race the camera.
    const codes = createPairCodes();
    expect(codes.current().code).toBe(codes.current().code);
  });

  it("claims exactly once, then never again", () => {
    const codes = createPairCodes();
    const { code } = codes.current();
    expect(codes.claim(code)).toBe(true);
    expect(codes.claim(code)).toBe(false);
  });

  it("mints a different code after one is spent", () => {
    const codes = createPairCodes();
    const first = codes.current().code;
    codes.claim(first);
    expect(codes.current().code).not.toBe(first);
  });

  it("peek does not spend the code", () => {
    const codes = createPairCodes();
    const { code } = codes.current();
    expect(codes.peek(code)).toBe(true);
    expect(codes.peek(code)).toBe(true);
    expect(codes.claim(code)).toBe(true);
  });

  it("refuses a code once its TTL has elapsed", () => {
    const clock = fakeClock();
    const codes = createPairCodes({ ttlMs: 60_000, now: clock.now });
    const { code } = codes.current();
    clock.advance(59_999);
    expect(codes.peek(code)).toBe(true);
    clock.advance(1);
    expect(codes.peek(code)).toBe(false);
    expect(codes.claim(code)).toBe(false);
  });

  it("mints a fresh code once the old one has expired", () => {
    const clock = fakeClock();
    const codes = createPairCodes({ ttlMs: 60_000, now: clock.now });
    const first = codes.current().code;
    clock.advance(60_000);
    expect(codes.current().code).not.toBe(first);
  });

  it("refuses anything that is not a live code", () => {
    const codes = createPairCodes();
    codes.current();
    expect(codes.peek("wrong")).toBe(false);
    expect(codes.peek("")).toBe(false);
    expect(codes.peek(null)).toBe(false);
    expect(codes.peek(undefined)).toBe(false);
    expect(codes.claim(12345)).toBe(false);
  });

  it("refuses a code of the wrong length without throwing", () => {
    // timingSafeEqual throws on a length mismatch; the digest compare must
    // length-guard before it gets there.
    const codes = createPairCodes();
    codes.current();
    expect(() => codes.peek("ab")).not.toThrow();
    expect(codes.peek("ab")).toBe(false);
  });

  it("has no live code before one is asked for", () => {
    const codes = createPairCodes();
    expect(codes.peek("anything")).toBe(false);
  });

  it("invalidate drops the live code without spending it", () => {
    const codes = createPairCodes();
    const { code } = codes.current();
    codes.invalidate();
    expect(codes.peek(code)).toBe(false);
    expect(codes.current().code).not.toBe(code);
  });
});
