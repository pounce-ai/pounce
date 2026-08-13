/**
 * The picker must never loosen itself.
 *
 * Reported bug: opening a thread that had been running in `acceptEdits` moved
 * the mode control to acceptEdits. Nothing announced it, and the next turn
 * would have approved file writes without asking — a permission the person
 * never granted, taken by opening a thread.
 */
import { describe, expect, it } from "vitest";
import { adoptedMode, isEscalation } from "./permissionModes";

describe("following the host's mode", () => {
  it("refuses to loosen what the user is showing", () => {
    // The bug, in all three directions it could happen.
    expect(adoptedMode("default", "acceptEdits")).toBe("default");
    expect(adoptedMode("default", "bypassPermissions")).toBe("default");
    expect(adoptedMode("plan", "acceptEdits")).toBe("plan");
  });

  it("adopts a stricter mode, which can only reduce what happens next", () => {
    expect(adoptedMode("acceptEdits", "plan")).toBe("plan");
    expect(adoptedMode("bypassPermissions", "default")).toBe("default");
    expect(adoptedMode("default", "plan")).toBe("plan");
  });

  it("takes the host's word when the user has chosen nothing", () => {
    // No decision to protect yet — the picker showing the agent's default while
    // the thread actually runs in plan is a lie about the next turn.
    expect(adoptedMode(undefined, "acceptEdits")).toBe("acceptEdits");
    expect(adoptedMode(undefined, "plan")).toBe("plan");
  });

  it("leaves the shown mode alone when the host reports nothing", () => {
    expect(adoptedMode("plan", null)).toBe("plan");
    expect(adoptedMode("plan", undefined)).toBe("plan");
    expect(adoptedMode(undefined, null)).toBeUndefined();
  });

  it("keeps an identical mode identical", () => {
    expect(adoptedMode("acceptEdits", "acceptEdits")).toBe("acceptEdits");
  });
});

describe("naming the dangerous transition", () => {
  it("is an escalation only when the host is more permissive", () => {
    expect(isEscalation("default", "acceptEdits")).toBe(true);
    expect(isEscalation("acceptEdits", "default")).toBe(false);
    expect(isEscalation("plan", "plan")).toBe(false);
  });

  it("is never an escalation when either side is unset", () => {
    // Nothing chosen yet is not a decision being overridden.
    expect(isEscalation(undefined, "bypassPermissions")).toBe(false);
    expect(isEscalation("default", null)).toBe(false);
  });
});

describe("a mode we have never heard of", () => {
  it("is never adopted over something the user is showing", () => {
    // Three hardcoded lists have to agree: the union in @pounce/shared, the
    // bridge's per-agent alias map (Claude's own `auto`/`normal` land here as
    // acceptEdits/default), and the picker's options. Add a mode to one and not
    // the others and an unranked string reaches this code — where `undefined >
    // 1` is false, which reads as "not an escalation" and lets it through.
    const unknown = "yoloMode" as never;
    expect(adoptedMode("default", unknown)).toBe("default");
    expect(adoptedMode("plan", unknown)).toBe("plan");
    expect(isEscalation("default", unknown)).toBe(true);
  });

  it("still yields to a mode we do understand", () => {
    // Nothing known is more permissive than something unrankable, so a real
    // mode is an improvement on it.
    expect(adoptedMode("yoloMode" as never, "plan")).toBe("plan");
  });
});
