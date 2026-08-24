import { describe, expect, it } from "vitest";
import { toAtif } from "./atif.mjs";

let seq = 0;
const ev = (type, extra = {}) => ({
  id: `e${++seq}`,
  conversationId: "t1",
  seq,
  ts: "2026-07-25T00:00:00.000Z",
  type,
  ...extra,
});
const call = (id, name, input = {}) =>
  ev("tool_call", { call: { id, name, input, status: "success" } });
const result = (toolCallId, text, isError = false) =>
  ev("tool_result", { result: { toolCallId, content: { kind: "text", text }, isError } });

const build = (events, usage = null) => toAtif({ agent: "claude", threadId: "t1", events, usage });

describe("toAtif", () => {
  it("emits a valid ATIF envelope", () => {
    const doc = build([ev("user_message", { text: "hi" })]);
    expect(doc.schema_version).toBe("1.7");
    expect(doc.trajectory_id).toBe("claude:t1");
    expect(doc.session_id).toBe("t1");
    expect(doc.agent.name).toBe("claude");
  });

  it("groups reasoning, message and tool calls into one agent step", () => {
    const doc = build([
      ev("user_message", { text: "go" }),
      ev("thinking_finished", { text: "pondering", durationMs: 0 }),
      ev("assistant_message", { text: "on it", streaming: false }),
      call("c1", "Read", { file: "a.ts" }),
    ]);
    expect(doc.steps).toHaveLength(2);
    expect(doc.steps[0]).toMatchObject({ source: "user", message: "go" });
    expect(doc.steps[1]).toMatchObject({
      source: "agent",
      reasoning_content: "pondering",
      message: "on it",
    });
    expect(doc.steps[1].tool_calls).toEqual([
      { tool_call_id: "c1", function_name: "Read", arguments: { file: "a.ts" } },
    ]);
  });

  it("attaches a tool result to the step that made the call", () => {
    const doc = build([call("c1", "Read"), result("c1", "file body")]);
    expect(doc.steps).toHaveLength(1);
    expect(doc.steps[0].observation.results).toEqual([
      { tool_call_id: "c1", content: "file body", is_error: false },
    ]);
  });

  it("matches results to calls out of order and across interleaving", () => {
    const doc = build([
      call("c1", "A"),
      call("c2", "B"),
      result("c2", "second"),
      result("c1", "first"),
    ]);
    const results = doc.steps[0].observation.results;
    expect(results.map((r) => r.tool_call_id)).toEqual(["c2", "c1"]);
    expect(results.find((r) => r.tool_call_id === "c1").content).toBe("first");
  });

  it("starts a new step once observations have come back", () => {
    // Tool output returning marks the boundary between two model calls —
    // without this a long tool-chaining turn collapses into one huge step.
    const doc = build([
      call("c1", "A"),
      result("c1", "out"),
      call("c2", "B"),
      result("c2", "out2"),
    ]);
    expect(doc.steps).toHaveLength(2);
    expect(doc.steps[0].tool_calls[0].tool_call_id).toBe("c1");
    expect(doc.steps[1].tool_calls[0].tool_call_id).toBe("c2");
  });

  it("splits consecutive finalized assistant messages into separate steps", () => {
    const doc = build([
      ev("assistant_message", { text: "one", streaming: false }),
      ev("assistant_message", { text: "two", streaming: false }),
    ]);
    expect(doc.steps.map((s) => s.message)).toEqual(["one", "two"]);
  });

  it("drops streaming deltas so text is not duplicated", () => {
    const doc = build([
      ev("assistant_message", { text: "par", streaming: true }),
      ev("assistant_message", { text: "partial done", streaming: false }),
    ]);
    expect(doc.steps).toHaveLength(1);
    expect(doc.steps[0].message).toBe("partial done");
  });

  it("keeps an orphan tool result as a system observation", () => {
    // Its tool_call fell outside a truncated history window — dropping it
    // would silently discard evidence of what the agent saw.
    const doc = build([result("missing", "output")]);
    expect(doc.steps).toHaveLength(1);
    expect(doc.steps[0].source).toBe("system");
    expect(doc.steps[0].observation.results[0].tool_call_id).toBe("missing");
  });

  it("renders each tool-result content kind as text", () => {
    const kinds = [
      [{ kind: "diff", path: "a.ts", patch: "@@ -1 +1 @@" }, "@@ -1 +1 @@"],
      [{ kind: "files", paths: ["a.ts", "b.ts"] }, "a.ts\nb.ts"],
      [{ kind: "json", value: { ok: true } }, '{"ok":true}'],
      [{ kind: "image", mediaType: "image/png" }, "[image image/png]"],
    ];
    for (const [content, expected] of kinds) {
      const doc = build([
        call("c1", "T"),
        ev("tool_result", { result: { toolCallId: "c1", content, isError: false } }),
      ]);
      expect(doc.steps[0].observation.results[0].content).toBe(expected);
    }
  });

  it("preserves Pounce-only events as system steps rather than dropping them", () => {
    const doc = build([
      ev("permission_request", {
        requestId: "r1",
        toolName: "Bash",
        toolTitle: "Run",
        options: [],
      }),
      ev("prompt_request", {
        promptId: "p1",
        title: "Trust folder?",
        kind: "trust",
        options: [],
        highlighted: 0,
        multiSelect: false,
      }),
      ev("git_event", { action: "commit", summary: "committed 2 files" }),
    ]);
    expect(doc.steps.map((s) => s.source)).toEqual(["system", "system", "system"]);
    expect(doc.steps.map((s) => s.extra.pounce_type)).toEqual([
      "permission_request",
      "prompt_request",
      "git_event",
    ]);
  });

  it("orders by seq and numbers steps contiguously", () => {
    const a = { ...ev("user_message", { text: "second" }), seq: 9 };
    const b = { ...ev("user_message", { text: "first" }), seq: 2 };
    const doc = build([a, b]);
    expect(doc.steps.map((s) => s.message)).toEqual(["first", "second"]);
    expect(doc.steps.map((s) => s.step_id)).toEqual([1, 2]);
  });

  it("reports cost only when the agent stated one", () => {
    const withCost = build([ev("user_message", { text: "x" })], {
      available: true,
      tokens: { input: 10, output: 5, cacheRead: 2, cacheCreation: 1, reasoning: 3, total: 18 },
      cost: 0.25,
      costComplete: true,
    });
    expect(withCost.final_metrics).toMatchObject({
      prompt_tokens: 10,
      completion_tokens: 5,
      cached_tokens: 2,
      total_tokens: 18,
      reasoning_tokens: 3,
      cost_usd: 0.25,
      cost_is_partial: false,
    });

    // Codex-shaped: tokens and plan usage, never a dollar figure.
    const noCost = build([ev("user_message", { text: "x" })], {
      available: true,
      tokens: { input: 10, output: 5, cacheRead: 0, cacheCreation: 0, total: 15 },
      cost: null,
      contextWindow: 258400,
      rateLimit: { usedPercent: 26, windowMinutes: 300, resetsAt: 1, planType: "plus" },
    });
    expect(noCost.final_metrics.cost_usd).toBeUndefined();
    expect(noCost.final_metrics).toMatchObject({ total_tokens: 15, model_context_window: 258400 });
    expect(noCost.final_metrics.rate_limit.planType).toBe("plus");
  });

  it("marks a partial cost so consumers don't sum it as a whole-thread total", () => {
    const doc = build([ev("user_message", { text: "x" })], {
      available: true,
      tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0, total: 2 },
      cost: 0.5,
      costComplete: false,
    });
    expect(doc.final_metrics.cost_is_partial).toBe(true);
  });

  it("returns empty metrics when no usage is available", () => {
    expect(build([ev("user_message", { text: "x" })]).final_metrics).toEqual({});
  });
});
