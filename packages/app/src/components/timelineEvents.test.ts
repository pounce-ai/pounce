import { describe, expect, it } from "vitest";
import type { TimelineEvent } from "@pounce/shared";
import {
  collapseToolResults,
  foldTurnRefetch,
  formatElapsed,
  runElapsedByRun,
} from "./timelineEvents";

// Minimal fixtures — collapseToolResults only reads .type, .id, .call.id and
// .result.toolCallId, so we build just those shapes and cast.
const call = (id: string, callId = id): TimelineEvent =>
  ({ type: "tool_call", id, call: { id: callId } }) as unknown as TimelineEvent;
const result = (toolCallId: string, id = `${toolCallId}:o`): TimelineEvent =>
  ({ type: "tool_result", id, result: { toolCallId } }) as unknown as TimelineEvent;
const msg = (id: string): TimelineEvent =>
  ({ type: "assistant_message", id, text: "", streaming: false }) as unknown as TimelineEvent;

const ids = (events: TimelineEvent[]) => events.map((e) => e.id);
const texts = (events: TimelineEvent[]) => events.map((e) => (e as { text?: string }).text ?? "");

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

// --- foldTurnRefetch --------------------------------------------------------
// A turn just finished and the host re-read the thread's transcript. What the
// render list should hold depends on whether that read is trustworthy.

const userMsg = (id: string, text: string): TimelineEvent =>
  ({ type: "user_message", id, text }) as unknown as TimelineEvent;
const asstMsg = (id: string, text: string, streaming = false): TimelineEvent =>
  ({ type: "assistant_message", id, text, streaming }) as unknown as TimelineEvent;

describe("foldTurnRefetch", () => {
  const history = [userMsg("h1", "older ask"), asstMsg("h2", "older reply")];

  it("adopts a re-read that covers the history it replaces", () => {
    const streamed = [asstMsg("s1", "reply", true)];
    const cur = [...history, ...streamed];
    const fetched = [...history, asstMsg("f1", "reply")];
    const out = foldTurnRefetch(cur, streamed, fetched);
    expect(texts(out)).toEqual(["older ask", "older reply", "reply"]);
    // the streamed row keeps its identity (and so its measured height) while
    // taking the fetched payload's settled flag
    expect(out[2].id).toBe("s1");
    expect((out[2] as { streaming?: boolean }).streaming).toBe(false);
  });

  // The regression this exists for: a turn that fails before the agent writes a
  // transcript (a plan's usage running out mid-turn) re-reads as nothing, and
  // adopting that emptied the whole thread.
  it("keeps the thread when the re-read comes back empty", () => {
    const streamed = [userMsg("s0", "new ask"), asstMsg("s1", "you've hit your usage limit")];
    const cur = [...history, ...streamed];
    expect(foldTurnRefetch(cur, streamed, [])).toEqual(cur);
  });

  // Same defect one step along: reading the WRONG session (an ACP resume that
  // forked) answers with a short, real-looking transcript.
  it("keeps the thread when the re-read is shorter than the history it replaces", () => {
    const streamed = [userMsg("s0", "new ask")];
    const cur = [...history, ...streamed];
    const strangerThread = [userMsg("x1", "new ask")];
    expect(foldTurnRefetch(cur, streamed, strangerThread)).toEqual(cur);
  });

  it("still appends streamed rows the transcript hasn't flushed yet", () => {
    const streamed = [userMsg("s0", "new ask"), asstMsg("s1", "reply")];
    const cur = [...history];
    const fetched = [...history];
    const out = foldTurnRefetch(cur, streamed, fetched);
    expect(texts(out)).toEqual(["older ask", "older reply", "new ask", "reply"]);
  });

  it("seeds an empty list from the fetch", () => {
    expect(foldTurnRefetch([], [], history)).toEqual(history);
  });
});

// --- duplicate Thought cards ------------------------------------------------

const thought = (id: string, text: string): TimelineEvent =>
  ({ type: "thinking_finished", id, text }) as unknown as TimelineEvent;

describe("duplicate reasoning", () => {
  // The two identical "Thought · 14 words" cards seen in a codex session.
  it("drops a Thought that repeats the one directly above it", () => {
    const out = collapseToolResults([
      thought("t1", "Enhancing canary snapshot fields\nPlanning candidate field updates"),
      thought("t2", "Enhancing canary snapshot fields\nPlanning candidate field updates"),
      msg("m1"),
    ]);
    expect(ids(out)).toEqual(["t1", "m1"]);
  });

  // The separator difference that made the upstream content match miss in the
  // first place: the same words, assembled with different whitespace.
  it("treats the same words with different whitespace as a repeat", () => {
    const out = collapseToolResults([thought("t1", "one\ntwo"), thought("t2", "one\n\ntwo  ")]);
    expect(ids(out)).toEqual(["t1"]);
  });

  it("keeps a thought repeated later in the thread", () => {
    const out = collapseToolResults([thought("t1", "same"), msg("m1"), thought("t2", "same")]);
    expect(ids(out)).toEqual(["t1", "m1", "t2"]);
  });

  it("keeps consecutive thoughts that differ", () => {
    const out = collapseToolResults([thought("t1", "first"), thought("t2", "second")]);
    expect(ids(out)).toEqual(["t1", "t2"]);
  });

  // The real dedupe still has to happen upstream, where the row's identity (and
  // so its measured height) is preserved rather than a row being removed.
  it("matches a live thought against its transcript twin despite whitespace", () => {
    const live = [thought("live1", "one\ntwo")];
    const fetched = [thought("r:2026", "one\n\ntwo")];
    const out = foldTurnRefetch(live, live, fetched);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("live1"); // the rendered row keeps its key
  });
});
