import { describe, expect, it } from "vitest";
import type { TimelineEvent } from "@pounce/shared";
import { deriveTaskState, deriveTaskTimeline, parseTaskCall, taskProgress } from "./taskEvents";

// Minimal fixtures — the helpers only read .type, .id, .seq, .ts, .call and .result.
let seq = 0;
const call = (name: string, input: unknown, id = `t${++seq}`): TimelineEvent =>
  ({
    type: "tool_call",
    id,
    seq: seq++,
    ts: "2026-07-25T10:00:00.000Z",
    call: { id, name, input, status: "success" },
  }) as unknown as TimelineEvent;
const result = (toolCallId: string, text: string): TimelineEvent =>
  ({
    type: "tool_result",
    id: `${toolCallId}:o`,
    seq: seq++,
    ts: "2026-07-25T10:00:00.000Z",
    result: { toolCallId, content: { kind: "text", text }, isError: false },
  }) as unknown as TimelineEvent;
const msg = (id: string): TimelineEvent =>
  ({
    type: "assistant_message",
    id,
    seq: seq++,
    ts: "",
    text: "",
    streaming: false,
  }) as unknown as TimelineEvent;

const todo = (content: string, status: string, activeForm?: string) => ({
  content,
  status,
  ...(activeForm ? { activeForm } : {}),
});

/** The real Claude Code incremental shape: TaskCreate's id comes back in its
 *  RESULT text, then TaskUpdate references it. Verified against a live
 *  transcript (see taskEvents.ts). */
function createWithResult(subject: string, id: string, activeForm?: string) {
  const callId = `create-${id}`;
  return [
    call("TaskCreate", { subject, description: subject, activeForm }, callId),
    result(callId, `Task #${id} created successfully: ${subject}`),
  ];
}

describe("parseTaskCall (whole-list writes)", () => {
  it("parses Claude TodoWrite todos", () => {
    const items = parseTaskCall(
      call("TodoWrite", {
        todos: [
          todo("Read the parser", "completed", "Reading the parser"),
          todo("Fix the bug", "in_progress", "Fixing the bug"),
          todo("Run tests", "pending", "Running tests"),
        ],
      }),
    );
    expect(items).toEqual([
      { text: "Read the parser", status: "completed", activeForm: "Reading the parser" },
      { text: "Fix the bug", status: "in_progress", activeForm: "Fixing the bug" },
      { text: "Run tests", status: "pending", activeForm: "Running tests" },
    ]);
  });

  it("parses Codex update_plan steps", () => {
    const items = parseTaskCall(
      call("update_plan", {
        plan: [
          { step: "Explore the repo", status: "completed" },
          { step: "Write the patch", status: "in_progress" },
        ],
      }),
    );
    expect(items).toEqual([
      { text: "Explore the repo", status: "completed" },
      { text: "Write the patch", status: "in_progress" },
    ]);
  });

  it("tolerates the status vocabularies agents actually emit", () => {
    const items = parseTaskCall(
      call("update_plan", {
        plan: [
          { step: "a", status: "complete" },
          { step: "b", status: "done" },
          { step: "c", status: "IN-PROGRESS" },
          { step: "d", status: "active" },
          { step: "e", status: "wat" },
          { step: "f" },
        ],
      }),
    );
    expect(items?.map((i) => i.status)).toEqual([
      "completed",
      "completed",
      "in_progress",
      "in_progress",
      "pending",
      "pending",
    ]);
  });

  it("accepts a bare string list", () => {
    expect(parseTaskCall(call("update_plan", { plan: ["one", "two"] }))).toEqual([
      { text: "one", status: "pending" },
      { text: "two", status: "pending" },
    ]);
  });

  it("returns null for non-task tool calls, other events, and the incremental tools", () => {
    expect(parseTaskCall(call("Read", { file_path: "/x" }))).toBeNull();
    expect(parseTaskCall(msg("m1"))).toBeNull();
    expect(parseTaskCall(call("TaskCreate", { subject: "a" }))).toBeNull();
  });

  it("returns null for malformed input rather than rendering an empty card", () => {
    expect(parseTaskCall(call("TodoWrite", undefined))).toBeNull();
    expect(parseTaskCall(call("TodoWrite", "nope"))).toBeNull();
    expect(parseTaskCall(call("TodoWrite", { todos: "nope" }))).toBeNull();
  });

  it("skips entries with no text but keeps the rest", () => {
    expect(
      parseTaskCall(
        call("TodoWrite", { todos: [todo("", "pending"), todo("real", "pending"), null, 7] }),
      ),
    ).toEqual([{ text: "real", status: "pending" }]);
  });

  it("distinguishes an empty list from a non-task call", () => {
    expect(parseTaskCall(call("TodoWrite", { todos: [] }))).toEqual([]);
  });
});

describe("deriveTaskState — whole-list writes", () => {
  it("takes the newest write (the agent rewrites the whole list every time)", () => {
    const state = deriveTaskState([
      call("TodoWrite", { todos: [todo("a", "pending"), todo("b", "pending")] }),
      msg("m1"),
      call("TodoWrite", { todos: [todo("a", "completed"), todo("b", "in_progress")] }),
      msg("m2"),
    ]);
    expect(state?.items.map((i) => i.status)).toEqual(["completed", "in_progress"]);
  });

  it("treats a newest empty write as a cleared list", () => {
    expect(
      deriveTaskState([
        call("TodoWrite", { todos: [todo("a", "pending")] }),
        call("TodoWrite", { todos: [] }),
      ]),
    ).toBeNull();
  });

  it("returns null for a thread with no task calls", () => {
    expect(deriveTaskState([msg("m1"), call("Read", { file_path: "/x" })])).toBeNull();
  });

  it("carries the source event id so the timeline can render that row's checklist", () => {
    const latest = call("TodoWrite", { todos: [todo("a", "pending")] }, "latest-id");
    expect(deriveTaskState([msg("m1"), latest])?.eventId).toBe("latest-id");
  });

  it("ignores a malformed newest call and keeps the last good list", () => {
    const state = deriveTaskState([
      call("TodoWrite", { todos: [todo("a", "completed")] }),
      call("TodoWrite", { todos: "corrupt" }),
    ]);
    expect(state?.items).toEqual([{ text: "a", status: "completed" }]);
  });
});

describe("deriveTaskState — incremental TaskCreate/TaskUpdate", () => {
  it("folds creates and updates into one list, in creation order", () => {
    const state = deriveTaskState([
      ...createWithResult("Say hello", "1", "Saying hello"),
      ...createWithResult("Say world", "2", "Saying world"),
      ...createWithResult("Say done", "3", "Saying done"),
      call("TaskUpdate", { taskId: "1", status: "completed" }),
      call("TaskUpdate", { taskId: "2", status: "in_progress" }),
    ]);
    expect(state?.items).toEqual([
      { text: "Say hello", status: "completed", activeForm: "Saying hello" },
      { text: "Say world", status: "in_progress", activeForm: "Saying world" },
      { text: "Say done", status: "pending", activeForm: "Saying done" },
    ]);
  });

  it("numbers by creation order when the result hasn't arrived yet (mid-stream)", () => {
    const state = deriveTaskState([
      call("TaskCreate", { subject: "First" }),
      call("TaskCreate", { subject: "Second" }),
      call("TaskUpdate", { taskId: "2", status: "completed" }),
    ]);
    expect(state?.items).toEqual([
      { text: "First", status: "pending" },
      { text: "Second", status: "completed" },
    ]);
  });

  it("honours the id the tool assigned, not the creation index", () => {
    // A resumed thread whose counter already advanced: ids are 7 and 8.
    const state = deriveTaskState([
      ...createWithResult("Seventh", "7"),
      ...createWithResult("Eighth", "8"),
      call("TaskUpdate", { taskId: "8", status: "completed" }),
    ]);
    expect(state?.items).toEqual([
      { text: "Seventh", status: "pending" },
      { text: "Eighth", status: "completed" },
    ]);
  });

  it("removes a deleted task from the list", () => {
    const state = deriveTaskState([
      ...createWithResult("Keep", "1"),
      ...createWithResult("Drop", "2"),
      call("TaskUpdate", { taskId: "2", status: "deleted" }),
    ]);
    expect(state?.items).toEqual([{ text: "Keep", status: "pending" }]);
  });

  it("applies a subject/activeForm rename", () => {
    const state = deriveTaskState([
      ...createWithResult("Old name", "1", "Doing old"),
      call("TaskUpdate", { taskId: "1", subject: "New name", activeForm: "Doing new" }),
    ]);
    expect(state?.items).toEqual([
      { text: "New name", status: "pending", activeForm: "Doing new" },
    ]);
  });

  it("survives an update for a task it never saw created", () => {
    const state = deriveTaskState([
      ...createWithResult("Known", "1"),
      call("TaskUpdate", { taskId: "99", status: "completed" }),
    ]);
    expect(state?.items).toEqual([{ text: "Known", status: "pending" }]);
  });

  it("prefers whichever shape the agent used most recently", () => {
    const foldFirst = deriveTaskState([
      ...createWithResult("Incremental", "1"),
      call("TodoWrite", { todos: [todo("Whole list", "pending")] }),
    ]);
    expect(foldFirst?.items).toEqual([{ text: "Whole list", status: "pending" }]);

    const listFirst = deriveTaskState([
      call("TodoWrite", { todos: [todo("Whole list", "pending")] }),
      ...createWithResult("Incremental", "1"),
    ]);
    expect(listFirst?.items).toEqual([{ text: "Incremental", status: "pending" }]);
  });
});

describe("deriveTaskTimeline row assignment", () => {
  it("gives the checklist to the newest task event and labels the rest", () => {
    const [c1, r1] = createWithResult("Say hello", "1");
    const [c2, r2] = createWithResult("Say world", "2");
    const done = call("TaskUpdate", { taskId: "1", status: "completed" }, "upd-1");
    const tl = deriveTaskTimeline([c1, r1, c2, r2, done]);
    expect(tl.latestEventId).toBe("upd-1");
    expect(tl.labels.get(c1.id)).toBe("＋ Say hello");
    expect(tl.labels.get(c2.id)).toBe("＋ Say world");
    // The row that renders the checklist carries no duplicate one-liner.
    expect(tl.labels.has("upd-1")).toBe(false);
    expect(tl.state?.items.map((i) => i.status)).toEqual(["completed", "pending"]);
  });

  it("labels an in-progress update with the present-tense form", () => {
    const [c1, r1] = createWithResult("Run the tests", "1", "Running the tests");
    const upd = call("TaskUpdate", { taskId: "1", status: "in_progress" }, "upd-x");
    const tl = deriveTaskTimeline([c1, r1, upd, msg("after")]);
    expect(tl.labels.get("upd-x")).toBeUndefined(); // it IS the latest → renders the card
    const tl2 = deriveTaskTimeline([
      c1,
      r1,
      upd,
      call("TaskUpdate", { taskId: "1", status: "completed" }, "upd-y"),
    ]);
    expect(tl2.labels.get("upd-x")).toBe("▸ Running the tests");
  });

  // Regression: Timeline used to fold the COLLAPSED list, where each tool_result
  // has been merged into its call. Without the results, TaskCreate ids fall back
  // to positional numbering — which silently mis-maps updates in a thread whose
  // task counter starts above 1, and disagrees with the pinned widget (which
  // folds the raw list). Both surfaces must fold the same, result-bearing list.
  it("needs the tool results to map updates onto the right tasks", () => {
    const [c7, r7] = createWithResult("Seventh", "7");
    const [c8, r8] = createWithResult("Eighth", "8");
    const upd = call("TaskUpdate", { taskId: "8", status: "completed" });

    const withResults = deriveTaskTimeline([c7, r7, c8, r8, upd]).state;
    expect(withResults?.items).toEqual([
      { text: "Seventh", status: "pending" },
      { text: "Eighth", status: "completed" },
    ]);

    // Same events with the results collapsed away: the update can no longer
    // find task 8, so nothing is marked done. This is the state the old
    // Timeline call site produced.
    const collapsed = deriveTaskTimeline([c7, c8, upd]).state;
    expect(collapsed?.items.every((i) => i.status === "pending")).toBe(true);
  });

  it("has no latest event and no state for a thread without task calls", () => {
    const tl = deriveTaskTimeline([msg("m1")]);
    expect(tl.latestEventId).toBeNull();
    expect(tl.state).toBeNull();
    expect(tl.labels.size).toBe(0);
  });
});

describe("taskProgress", () => {
  it("counts completions and picks the in-progress item's present tense", () => {
    expect(
      taskProgress([
        { text: "a", status: "completed" },
        { text: "b", status: "in_progress", activeForm: "Doing b" },
        { text: "c", status: "pending" },
      ]),
    ).toMatchObject({ done: 1, total: 3, activeLabel: "Doing b" });
  });

  it("falls back to the first pending item when nothing is in progress", () => {
    expect(
      taskProgress([
        { text: "a", status: "completed" },
        { text: "b", status: "pending" },
      ]),
    ).toMatchObject({ done: 1, total: 2, activeLabel: "b" });
  });

  it("has no active label once everything is done", () => {
    expect(taskProgress([{ text: "a", status: "completed" }])).toMatchObject({
      done: 1,
      total: 1,
      active: null,
      activeLabel: null,
    });
  });
});
