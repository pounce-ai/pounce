/**
 * OpenCode adapter regression tests.
 *
 * Fixtures use the shapes stored by opencode 1.17.4 in
 * ~/.local/share/opencode/opencode.db (part.data JSON).
 */
import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

// Control the child returned by the mocked spawn (hoisted so the factory sees it).
const h = vi.hoisted(() => ({ child: null }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawn: () => h.child };
});

import { OpencodeAdapter } from "./opencode.mjs";

/** getEvents() reads from the db, else the file store — stub the file path. */
function adapterWith(messages) {
  const a = new OpencodeAdapter({ turns: { isRunning: () => false } });
  a.db = async () => null;
  a._messagesFiles = () => messages;
  return a;
}

const msg = (role, parts) => ({
  data: { role, time: { created: 1770638073583 } },
  parts: parts.map((data, i) => ({ id: `prt_${role}_${i}`, data })),
});

// Verbatim from a real store: Subversion-flavoured unified diff.
const OC_DIFF = [
  "Index: /repo/calc.py",
  "===================================================================",
  "--- /repo/calc.py",
  "+++ /repo/calc.py",
  "@@ -1,2 +1,2 @@",
  " def add(a, b):",
  "-    return a - b",
  "+    return a + b",
].join("\n");

describe("opencode history — file edits render as diffs", () => {
  const editPart = {
    type: "tool",
    tool: "edit",
    callID: "call_1",
    state: {
      status: "completed",
      input: { filePath: "/repo/calc.py", oldString: "a - b", newString: "a + b" },
      output: "Edit applied successfully.",
      metadata: { diff: OC_DIFF },
    },
  };

  it("uses state.metadata.diff instead of the 'Edit applied successfully.' text", async () => {
    const ev = await adapterWith([msg("assistant", [editPart])]).getEvents("ses_1");
    const result = ev.find((e) => e.type === "tool_result");
    expect(result.result.content.kind).toBe("diff");
    expect(result.result.content.path).toBe("/repo/calc.py");
    expect(result.result.content.patch).toContain("+    return a + b");
    // splitPatch() keys on `diff --git`; without it the patch has no file name.
    expect(result.result.content.patch).toContain("diff --git a//repo/calc.py b//repo/calc.py");
    // The Index:/=== preamble is not diff metadata and would render as context.
    expect(result.result.content.patch).not.toContain("Index:");
    expect(result.result.content.patch).not.toMatch(/^=+$/m);
  });

  it("does not bury the card in both sides of the edit", async () => {
    const ev = await adapterWith([msg("assistant", [editPart])]).getEvents("ses_1");
    // The diff already says what changed.
    expect(ev.find((e) => e.type === "tool_call").call.input).toEqual({
      filePath: "/repo/calc.py",
    });
  });

  it("keeps plain text output for tools with no diff", async () => {
    const ev = await adapterWith([
      msg("assistant", [
        {
          type: "tool",
          tool: "bash",
          callID: "c2",
          state: { status: "completed", input: { command: "ls" }, output: "calc.py\n" },
        },
      ]),
    ]).getEvents("ses_1");
    expect(ev.find((e) => e.type === "tool_call").call.input).toEqual({ command: "ls" });
    expect(ev.find((e) => e.type === "tool_result").result.content).toEqual({
      kind: "text",
      text: "calc.py\n",
    });
  });

  it("ignores a metadata.diff with no hunks", async () => {
    const ev = await adapterWith([
      msg("assistant", [
        {
          type: "tool",
          tool: "edit",
          callID: "c3",
          state: {
            status: "completed",
            input: { filePath: "/repo/a.ts" },
            output: "done",
            metadata: { diff: "Index: /repo/a.ts\n" },
          },
        },
      ]),
    ]).getEvents("ses_1");
    expect(ev.find((e) => e.type === "tool_result").result.content.kind).toBe("text");
  });
});

describe("opencode history — previously dropped parts", () => {
  it("marks compaction so the transcript does not just jump", async () => {
    const ev = await adapterWith([
      msg("assistant", [{ type: "compaction", auto: true, overflow: false }]),
    ]).getEvents("ses_1");
    expect(ev[0].type).toBe("system_event");
    expect(ev[0].message).toBe("Context compacted");
  });

  // `opencode run` stores the prompt wrapped in quotes with inner quotes
  // escaped. Left alone, the app matched the fetched user message against the
  // streamed one by exact text, failed, and rendered the prompt twice.
  describe("unwraps `opencode run` prompt quoting", () => {
    const userText = async (stored) =>
      (await adapterWith([msg("user", [{ type: "text", text: stored }])]).getEvents("ses_1"))[0]
        .text;

    it("strips the wrapper", async () => {
      expect(await userText('"Add a LICENSE file."')).toBe("Add a LICENSE file.");
    });

    it("unescapes inner quotes and keeps literal newlines", async () => {
      // Verbatim shape from a real store: newlines are NOT escaped, so this is
      // not JSON and JSON.parse would throw on it.
      expect(await userText('"run \'{\\"key\\":\\"v\\"}\'\nsecond line"')).toBe(
        'run \'{"key":"v"}\'\nsecond line',
      );
    });

    it("leaves an ordinary prompt alone", async () => {
      expect(await userText("just do the thing")).toBe("just do the thing");
    });

    it("leaves a prompt that merely mentions quotes alone", async () => {
      // A bare inner quote can't have come from the wrapper — don't touch it.
      const s = '"He said "hi" to me"';
      expect(await userText(s)).toBe(s);
    });

    it("does not mangle a backslash", async () => {
      expect(await userText('"match \\d+ digits"')).toBe("match \\d+ digits");
    });
  });

  // The failure hangs off the message, not a part. Without this the refetch
  // that lands after a turn quietly erased the error the stream had shown.
  it("keeps a failed turn's error on refetch", async () => {
    const failed = msg("assistant", []);
    failed.id = "msg_1";
    failed.data.error = {
      name: "APIError",
      data: { message: "Insufficient balance.", statusCode: 401 },
    };
    const ev = await adapterWith([failed]).getEvents("ses_1");
    expect(ev).toHaveLength(1);
    expect(ev[0].type).toBe("system_event");
    expect(ev[0].level).toBe("error");
    expect(ev[0].message).toBe("Insufficient balance. (401)");
  });

  it("does not invent an error for a healthy turn", async () => {
    const ev = await adapterWith([msg("assistant", [{ type: "text", text: "done" }])]).getEvents(
      "ses_1",
    );
    expect(ev.some((e) => e.type === "system_event")).toBe(false);
  });

  it("still skips step/snapshot plumbing (history)", async () => {
    const ev = await adapterWith([
      msg("assistant", [
        { type: "step-start" },
        { type: "step-finish" },
        // `patch` is only {hash, files[]} — a snapshot marker, no diff text.
        { type: "patch", hash: "abc", files: ["/repo/a.ts"] },
      ]),
    ]).getEvents("ses_1");
    expect(ev).toHaveLength(0);
  });
});

describe("opencode streaming — `opencode run --format json`", () => {
  /** Drive startTurn with `lines`, resolving to everything it emitted. */
  function streamed(lines) {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    h.child = child;

    const turns = {
      assertCapacity() {},
      register: () => ({}),
      alias() {},
      release() {},
    };
    const events = [];
    const a = new OpencodeAdapter({ turns });
    const { done } = a.startTurn({ threadId: null, text: "fix it", cwd: undefined }, (e) =>
      events.push(e),
    );
    for (const l of lines) child.stdout.write(`${JSON.stringify(l)}\n`);
    child.stdout.end();
    child.emit("close", 0);
    return done.then((tid) => ({ events, tid }));
  }

  // Verbatim envelope from opencode 1.17.4.
  const wrap = (part) => ({
    type: "part.updated",
    timestamp: 1770638073583,
    sessionID: "ses_live1",
    part,
  });

  it("renders a live file edit as a diff, not 'Edit applied successfully.'", async () => {
    const { events } = await streamed([
      wrap({
        id: "prt_1",
        type: "tool",
        tool: "edit",
        callID: "call_live",
        state: {
          status: "completed",
          input: { filePath: "/repo/calc.py" },
          output: "Edit applied successfully.",
          metadata: { diff: OC_DIFF },
        },
      }),
    ]);
    const result = events.find((e) => e.type === "tool_result");
    expect(result.result.content.kind).toBe("diff");
    expect(result.result.content.patch).toContain("+    return a + b");
    expect(result.result.content.patch).toContain("diff --git a//repo/calc.py b//repo/calc.py");
  });

  it("picks up the session id from the stream", async () => {
    const { tid } = await streamed([wrap({ id: "p", type: "text", text: "hi" })]);
    expect(tid).toBe("ses_live1");
  });

  // Verbatim from a run against an out-of-credit opencode Zen account. The
  // whole turn is this one line: no part, so it used to be dropped and the
  // thread ended holding nothing but the user's own message.
  it("surfaces a failed turn instead of ending silently", async () => {
    const { events } = await streamed([
      {
        type: "error",
        timestamp: 1786223457805,
        sessionID: "ses_live1",
        error: {
          name: "APIError",
          data: { message: "Insufficient balance.", statusCode: 401 },
        },
      },
    ]);
    const err = events.find((e) => e.type === "system_event");
    expect(err.level).toBe("error");
    expect(err.message).toBe("Insufficient balance. (401)");
  });

  it("falls back to the error name when there is no message", async () => {
    const { events } = await streamed([
      { type: "error", sessionID: "ses_live1", error: { name: "UnknownError" } },
    ]);
    expect(events.find((e) => e.type === "system_event").message).toBe("UnknownError");
  });

  it("emits no result while a tool is still running", async () => {
    const { events } = await streamed([
      wrap({
        id: "prt_2",
        type: "tool",
        tool: "bash",
        callID: "c_run",
        state: { status: "running", input: { command: "sleep 1" }, output: "" },
      }),
    ]);
    expect(events.find((e) => e.type === "tool_call").call.status).toBe("running");
    expect(events.some((e) => e.type === "tool_result")).toBe(false);
  });
});
