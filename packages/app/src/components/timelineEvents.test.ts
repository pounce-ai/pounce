import { describe, expect, it } from "vitest";
import type { TimelineEvent } from "@pounce/shared";
import { collapseToolResults, formatElapsed, runElapsedByRun } from "./timelineEvents";

// Minimal fixtures — collapseToolResults only reads .type, .id, .call.id and
// .result.toolCallId, so we build just those shapes and cast.
const call = (id: string, callId = id): TimelineEvent =>
  ({ type: "tool_call", id, call: { id: callId } }) as unknown as TimelineEvent;
const result = (toolCallId: string, id = `${toolCallId}:o`): TimelineEvent =>
  ({ type: "tool_result", id, result: { toolCallId } }) as unknown as TimelineEvent;
const msg = (id: string): TimelineEvent =>
  ({ type: "assistant_message", id, text: "", streaming: false }) as unknown as TimelineEvent;

const ids = (events: TimelineEvent[]) => events.map((e) => e.id);

describe("collapseToolResults", () => {
  it("drops a tool_result whose tool_call is present (rendered inline)", () => {
    const out = collapseToolResults([call("t1"), result("t1"), msg("m1")]);
    expect(out.map((e) => e.type)).toEqual(["tool_call", "assistant_message"]);
  });

  it("keeps a tool_result with no matching tool_call", () => {
    const out = collapseToolResults([result("orphan"), msg("m1")]);
    expect(out.map((e) => e.type)).toEqual(["tool_result", "assistant_message"]);
  });

  it("matches a call by call.id when it differs from the event id", () => {
    // event id != call.id; the result references the call.id
    const out = collapseToolResults([call("evt1", "toolu_X"), result("toolu_X", "toolu_X:o")]);
    expect(out.map((e) => e.type)).toEqual(["tool_call"]);
  });

  // Regression: the "Detected overlapping key" LegendList crash. A streamed live
  // event and its re-parsed transcript twin can share an id; the collapsed list
  // must never contain two events with the same id (keyExtractor = e.id).
  it("dedups events sharing an id, keeping one, preserving order", () => {
    const dup = "toolu_01FA3r1ZrTPevtE3imvNWcEE";
    const out = collapseToolResults([msg("a"), call(dup), call(dup), msg("b")]);
    expect(ids(out)).toEqual(["a", dup, "b"]);
    // no duplicate keys survive
    expect(new Set(ids(out)).size).toBe(out.length);
  });

  it("keeps the LAST occurrence of a duplicated id (authoritative transcript copy)", () => {
    const live = {
      type: "assistant_message",
      id: "x",
      text: "partial",
      streaming: true,
    } as unknown as TimelineEvent;
    const reparsed = {
      type: "assistant_message",
      id: "x",
      text: "final",
      streaming: false,
    } as unknown as TimelineEvent;
    const out = collapseToolResults([live, reparsed]);
    expect(out).toHaveLength(1);
    expect((out[0] as { text: string }).text).toBe("final");
  });

  it("is idempotent so marker indices stay aligned with the rendered list", () => {
    const input = [msg("a"), call("t1"), result("t1"), call("dup"), call("dup"), msg("b")];
    const once = collapseToolResults(input);
    const twice = collapseToolResults(once);
    expect(ids(twice)).toEqual(ids(once));
  });
});

// `ts` matters here where it did not above, so these build their own fixtures.
const callAt = (id: string, ts: string, callId = id): TimelineEvent =>
  ({ type: "tool_call", id, ts, call: { id: callId } }) as unknown as TimelineEvent;
const resultAt = (toolCallId: string, ts: string): TimelineEvent =>
  ({
    type: "tool_result",
    id: `${toolCallId}:o`,
    ts,
    result: { toolCallId },
  }) as unknown as TimelineEvent;

/** The single-run shape the old per-run helper had, so these cases stay
 *  readable: run "r" over the given call ids. */
const elapsed = (events: TimelineEvent[], ids: string[]): number | null =>
  runElapsedByRun(events, [{ id: "r", ids }]).get("r") ?? null;

describe("runElapsedByRun", () => {
  it("spans the first call to the LAST result, not the last call", () => {
    // The finishing timestamp lives on the result — measuring call-to-call
    // would drop however long the final command actually took.
    const events = [
      callAt("a", "2026-08-09T10:00:00.000Z"),
      callAt("b", "2026-08-09T10:00:05.000Z"),
      resultAt("a", "2026-08-09T10:00:03.000Z"),
      resultAt("b", "2026-08-09T10:00:22.000Z"),
    ];
    expect(elapsed(events, ["a", "b"])).toBe(22_000);
  });

  it("matches a result by call.id when it differs from the event id", () => {
    const events = [
      callAt("evt1", "2026-08-09T10:00:00.000Z", "toolu_X"),
      resultAt("toolu_X", "2026-08-09T10:00:04.000Z"),
    ];
    expect(elapsed(events, ["evt1"])).toBe(4_000);
  });

  it("ignores calls outside the run", () => {
    const events = [
      callAt("a", "2026-08-09T10:00:00.000Z"),
      resultAt("a", "2026-08-09T10:00:02.000Z"),
      callAt("z", "2026-08-09T10:05:00.000Z"),
      resultAt("z", "2026-08-09T10:09:00.000Z"),
    ];
    expect(elapsed(events, ["a"])).toBe(2_000);
  });

  it("is null under a second — 'Worked for 0s' says less than nothing", () => {
    const events = [
      callAt("a", "2026-08-09T10:00:00.000Z"),
      resultAt("a", "2026-08-09T10:00:00.400Z"),
    ];
    expect(elapsed(events, ["a"])).toBeNull();
  });

  it("is null while the run is still going (no results yet)", () => {
    expect(elapsed([callAt("a", "2026-08-09T10:00:00.000Z")], ["a"])).toBeNull();
  });

  it("is null when the run has no calls at all", () => {
    expect(elapsed([msg("m")], ["nope"])).toBeNull();
  });

  it("keeps runs apart when several are measured in one pass", () => {
    const events = [
      callAt("a", "2026-08-09T10:00:00.000Z"),
      resultAt("a", "2026-08-09T10:00:02.000Z"),
      callAt("z", "2026-08-09T10:05:00.000Z"),
      resultAt("z", "2026-08-09T10:09:00.000Z"),
    ];
    const spans = runElapsedByRun(events, [
      { id: "first", ids: ["a"] },
      { id: "second", ids: ["z"] },
    ]);
    expect(spans.get("first")).toBe(2_000);
    expect(spans.get("second")).toBe(240_000);
  });

  it("omits a run whose calls carry no parsable timestamp", () => {
    const events = [callAt("a", "not-a-date"), resultAt("a", "2026-08-09T10:00:09.000Z")];
    expect(runElapsedByRun(events, [{ id: "r", ids: ["a"] }]).has("r")).toBe(false);
  });
});

describe("formatElapsed", () => {
  it.each([
    [22_000, "22s"],
    [59_400, "59s"],
    [60_000, "1m"],
    [90_000, "1m 30s"],
    [125_000, "2m 5s"],
    [120_000, "2m"],
  ])("formats %ims as %s", (ms, expected) => {
    expect(formatElapsed(ms)).toBe(expected);
  });
});
