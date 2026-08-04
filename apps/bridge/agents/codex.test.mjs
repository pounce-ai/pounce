/**
 * Codex adapter regression tests.
 *
 * Every fixture below is a VERBATIM record shape captured from codex-cli 0.146
 * (live `codex exec --json`) or from a real ~/.codex rollout. The adapter was
 * originally written against documentation rather than a binary, and each of
 * these shapes is one the doc-derived parser got wrong.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// listModels() reads two fixed paths under ~/.codex. Override just those reads
// (by filename suffix) so the tests are independent of the dev machine's real
// Codex install; everything else falls through to the real fs.
const stub = vi.hoisted(() => ({ files: new Map() }));
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal();
  const readFileSync = (p, ...rest) => {
    for (const [suffix, content] of stub.files) {
      if (String(p).endsWith(suffix)) {
        if (content == null) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return content;
      }
    }
    return real.readFileSync(p, ...rest);
  };
  return { ...real, readFileSync, default: { ...real, readFileSync } };
});

const { CodexAdapter } = await import("./codex.mjs");

const TS = "2026-08-04T10:00:00.000Z";

/** Build an adapter reading a temp rollout made of `records`. */
function adapterFor(records) {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-test-"));
  const file = path.join(dir, "rollout.jsonl");
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n"));
  const a = new CodexAdapter({ turns: { isRunning: () => false } });
  a.findFile = async () => file;
  return { a, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const item = (payload) => ({ type: "response_item", timestamp: TS, payload });

async function eventsFor(records) {
  const { a, cleanup } = adapterFor(records);
  try {
    return await a.getEvents("t1");
  } finally {
    cleanup();
  }
}

describe("codex history — tool call payloads", () => {
  it("reads custom_tool_call.input, not just function_call.arguments", async () => {
    // `exec` is a custom tool: its payload lives in `input`. Reading only
    // `arguments` left 95/95 exec cards blank on a real host.
    const ev = await eventsFor([
      item({ type: "custom_tool_call", name: "exec", call_id: "c1", input: "git status --short" }),
    ]);
    const call = ev.find((e) => e.type === "tool_call");
    expect(call.call.name).toBe("shell");
    expect(call.call.input.command).toBe("git status --short");
  });

  it("still parses function_call.arguments JSON", async () => {
    const ev = await eventsFor([
      item({
        type: "function_call",
        name: "exec_command",
        call_id: "c1",
        arguments: JSON.stringify({ cmd: "pwd", workdir: "/tmp" }),
      }),
    ]);
    expect(ev[0].call.input.command).toBe("pwd");
  });

  it("keeps non-shell freeform payloads instead of dropping them", async () => {
    const ev = await eventsFor([
      item({ type: "custom_tool_call", name: "mystery", call_id: "c1", input: "raw payload" }),
    ]);
    expect(ev[0].call.input).toEqual({ text: "raw payload" });
  });
});

describe("codex history — apply_patch renders as a diff", () => {
  const PATCH = [
    "*** Begin Patch",
    "*** Update File: src/a.ts",
    "@@",
    "-const a = 1;",
    "+const a = 2;",
    "*** Add File: src/b.ts",
    "+export const b = 3;",
    "*** End Patch",
  ].join("\n");

  it("converts the apply_patch envelope into a unified diff", async () => {
    const ev = await eventsFor([
      item({ type: "custom_tool_call", name: "apply_patch", call_id: "p1", input: PATCH }),
      item({ type: "custom_tool_call_output", call_id: "p1", output: "Success" }),
    ]);
    const result = ev.find((e) => e.type === "tool_result");
    expect(result.result.content.kind).toBe("diff");
    // splitPatch() keys on `diff --git`, so both files must carry a header.
    expect(result.result.content.patch).toContain("diff --git a/src/a.ts b/src/a.ts");
    expect(result.result.content.patch).toContain("diff --git a/src/b.ts b/src/b.ts");
    expect(result.result.content.patch).toContain("+const a = 2;");
    // Envelope directives are not diff content.
    expect(result.result.content.patch).not.toContain("*** Begin Patch");
    expect(result.result.content.path).toBe("src/a.ts");
  });

  it("leaves ordinary tool output as text", async () => {
    const ev = await eventsFor([
      item({ type: "custom_tool_call", name: "exec", call_id: "c1", input: "ls" }),
      item({ type: "custom_tool_call_output", call_id: "c1", output: "a.ts\n" }),
    ]);
    const result = ev.find((e) => e.type === "tool_result");
    expect(result.result.content).toEqual({ kind: "text", text: "a.ts\n" });
  });
});

describe("codex history — tool output envelopes", () => {
  it("unwraps an array of input_text content parts", async () => {
    // What `exec` actually returns; previously rendered as raw JSON.
    const output = JSON.stringify([
      { type: "input_text", text: "Script completed\n" },
      { type: "input_text", text: "ok\n" },
    ]);
    const ev = await eventsFor([
      item({ type: "custom_tool_call", name: "exec", call_id: "c1", input: "ls" }),
      item({ type: "custom_tool_call_output", call_id: "c1", output }),
    ]);
    const result = ev.find((e) => e.type === "tool_result");
    expect(result.result.content.text).toBe("Script completed\nok\n");
  });

  it("unwraps the {output} envelope", async () => {
    const ev = await eventsFor([
      item({ type: "function_call", name: "shell", call_id: "c1", arguments: "{}" }),
      item({
        type: "function_call_output",
        call_id: "c1",
        output: JSON.stringify({ output: "hi", metadata: {} }),
      }),
    ]);
    expect(ev.find((e) => e.type === "tool_result").result.content.text).toBe("hi");
  });
});

describe("codex history — reasoning", () => {
  it("falls back to content[] when summary is empty", async () => {
    const ev = await eventsFor([
      item({ type: "reasoning", summary: [], content: [{ type: "reasoning_text", text: "why" }] }),
    ]);
    expect(ev[0].type).toBe("thinking_finished");
    expect(ev[0].text).toBe("why");
  });

  it("emits nothing when the text is encrypted-only", async () => {
    // 861/861 reasoning items in a real rollout look exactly like this — there
    // is no plaintext to show, so a thinking block would be empty chrome.
    const ev = await eventsFor([
      item({ type: "reasoning", summary: [], content: null, encrypted_content: "gAAAAA..." }),
    ]);
    expect(ev).toHaveLength(0);
  });
});

describe("codex history — previously dropped records", () => {
  it("surfaces web_search_call", async () => {
    const ev = await eventsFor([
      item({
        type: "web_search_call",
        call_id: "w1",
        status: "completed",
        action: { type: "search", query: "shopify scopes" },
      }),
    ]);
    expect(ev[0].type).toBe("tool_call");
    expect(ev[0].call.name).toBe("web_search");
    expect(ev[0].call.input.query).toBe("shopify scopes");
  });

  it("marks compaction and rollback so the transcript does not just jump", async () => {
    const ev = await eventsFor([
      { type: "event_msg", timestamp: TS, payload: { type: "context_compacted" } },
      { type: "event_msg", timestamp: TS, payload: { type: "thread_rolled_back" } },
    ]);
    expect(ev.map((e) => e.message)).toEqual(["Context compacted", "Thread rolled back"]);
  });
});

describe("codex history — injected user turns", () => {
  it("drops codex plumbing injected as user messages", async () => {
    const ev = await eventsFor([
      item({
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: '<codex_internal_context source="goal">go</codex_internal_context>',
          },
        ],
      }),
      item({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "<turn_aborted>\nstopped\n</turn_aborted>" }],
      }),
      item({ type: "message", role: "user", content: [{ type: "input_text", text: "real ask" }] }),
    ]);
    expect(ev.filter((e) => e.type === "user_message").map((e) => e.text)).toEqual(["real ask"]);
  });

  it("gives every event a unique id (streaming ids restart per turn)", async () => {
    // Colliding ids crashed the app's message insert ("already exists").
    const ev = await eventsFor([
      item({ type: "message", role: "assistant", content: [{ type: "output_text", text: "a" }] }),
      item({ type: "message", role: "assistant", content: [{ type: "output_text", text: "b" }] }),
    ]);
    expect(new Set(ev.map((e) => e.id)).size).toBe(ev.length);
  });
});

describe("codex listModels — read from Codex, never hardcoded", () => {
  const adapter = () => new CodexAdapter({ turns: { isRunning: () => false } });
  const cache = (models) => JSON.stringify({ fetched_at: "2026-08-04T11:51:10Z", models });
  // Verbatim shape from a real ~/.codex/models_cache.json.
  const MODELS = [
    {
      slug: "gpt-5.6-terra",
      display_name: "GPT-5.6-Terra",
      description: "Balanced.",
      visibility: "list",
      priority: 2,
    },
    {
      slug: "codex-auto-review",
      display_name: "Codex Auto Review",
      visibility: "hide",
      priority: 1,
    },
    { slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list", priority: 3 },
  ];

  beforeEach(() => {
    stub.files.clear();
  });

  it("lists the account's real models, hiding internal entries", () => {
    stub.files.set("models_cache.json", cache(MODELS));
    stub.files.set("config.toml", 'model = "gpt-5.5"\n');
    const got = adapter().listModels();
    expect(got.map((m) => m.id)).toEqual(["gpt-5.6-terra", "gpt-5.5"]); // priority order, no auto-review
    expect(got[0].name).toBe("GPT-5.6-Terra");
    expect(got[0].description).toBe("Balanced.");
  });

  it("takes the default from config.toml", () => {
    stub.files.set("models_cache.json", cache(MODELS));
    stub.files.set("config.toml", 'model = "gpt-5.5"\n');
    expect(
      adapter()
        .listModels()
        .find((m) => m.isDefault).id,
    ).toBe("gpt-5.5");
  });

  it("ignores a per-project model under a [table] header", () => {
    stub.files.set("models_cache.json", cache(MODELS));
    stub.files.set("config.toml", '[projects."/tmp/x"]\nmodel = "gpt-5.5"\n');
    // No top-level model → default falls to the highest-priority entry.
    expect(
      adapter()
        .listModels()
        .find((m) => m.isDefault).id,
    ).toBe("gpt-5.6-terra");
  });

  it("does not mark a configured model the account no longer has as default", () => {
    // The exact broken state: config pinned gpt-5.4, which the server rejected.
    stub.files.set("models_cache.json", cache(MODELS));
    stub.files.set("config.toml", 'model = "gpt-5.4"\n');
    const got = adapter().listModels();
    expect(got.map((m) => m.id)).not.toContain("gpt-5.4");
    expect(got.find((m) => m.isDefault).id).toBe("gpt-5.6-terra");
  });

  it("falls back to the configured model when no cache exists", () => {
    stub.files.set("models_cache.json", null); // ENOENT
    stub.files.set("config.toml", 'model = "gpt-5.5"\n');
    expect(adapter().listModels()).toEqual([
      { id: "gpt-5.5", name: "gpt-5.5", description: null, isDefault: true, deprecated: false },
    ]);
  });

  it("invents nothing when there is neither a cache nor a config", () => {
    stub.files.set("models_cache.json", null);
    stub.files.set("config.toml", null);
    expect(adapter().listModels()).toEqual([]);
  });
});
