import { describe, expect, it } from "vitest";
import type { TimelineEvent } from "@litter/shared";
import { collapseToolResults } from "./timelineEvents";

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
