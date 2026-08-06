import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Control the child returned by the mocked spawn (hoisted so the factory sees it).
const h = vi.hoisted(() => ({ child: null }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawn: () => h.child };
});

// Force "unknown" liveness so getActivity exercises its mtime fallback (the path
// that's always taken on Windows / when ps·lsof fail); other helpers untouched.
vi.mock("./env.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, liveAgentCwds: () => Promise.resolve(null) };
});

import {
  CursorAdapter,
  isErrorResult,
  parseAuthStatus,
  resultText,
  scanRoot,
  shapeCall,
  shapeStreamCall,
  userQueryText,
} from "./cursor.mjs";

// node:sqlite is stable only on Node ≥ 24; guard the store-db test so it runs
// where available (dev + the bridge's node) and skips on older CI node. Loaded
// via createRequire so vite-node doesn't rewrite the (new) builtin specifier.
import { createRequire } from "node:module";
let DatabaseSync = null;
try {
  ({ DatabaseSync } = createRequire(import.meta.url)("node:sqlite"));
} catch {}

// ── auth parsing ──────────────────────────────────────────────────────────────
describe("parseAuthStatus", () => {
  it("reads a signed-in line", () => {
    expect(parseAuthStatus("✓ Logged in as a@b.com")).toEqual({
      required: true,
      authenticated: true,
      account: "a@b.com",
    });
  });
  it("treats 'Not logged in' as unauthenticated (substring trap)", () => {
    expect(parseAuthStatus("Not logged in")).toEqual({
      required: true,
      authenticated: false,
      account: null,
    });
  });
  it("null (spawn failed) → unauthenticated", () => {
    expect(parseAuthStatus(null).authenticated).toBe(false);
  });
});

// ── tool + text shaping ───────────────────────────────────────────────────────
describe("shapeStreamCall (live stream tools)", () => {
  it("shell started: normalizes name + command, no result yet", () => {
    expect(shapeStreamCall({ shellToolCall: { args: { command: "echo hi" } } })).toMatchObject({
      name: "shell",
      input: { command: "echo hi" },
      result: null,
      isError: false,
    });
  });
  it("shell completed: extracts stdout", () => {
    const r = shapeStreamCall({
      shellToolCall: { args: { command: "echo hi" }, result: { success: { stdout: "hi\n" } } },
    });
    expect(r.result).toBe("hi\n");
    expect(r.isError).toBe(false);
  });
  it("non-shell tool with an error result", () => {
    expect(
      shapeStreamCall({ readToolCall: { args: { path: "x" }, result: { error: "nope" } } }),
    ).toMatchObject({
      name: "read",
      input: { path: "x" },
      result: "nope",
      isError: true,
    });
  });
});

describe("stored helpers", () => {
  it("shapeCall normalizes Shell → shell{command}, keeps others", () => {
    expect(shapeCall({ toolName: "Shell", args: { command: "ls -a" } })).toMatchObject({
      name: "shell",
      input: { command: "ls -a" },
    });
    expect(shapeCall({ toolName: "Read", args: { path: "y" } })).toMatchObject({
      name: "Read",
      input: { path: "y" },
    });
  });
  it("resultText prefers the string result, else experimental text", () => {
    expect(resultText({ result: "out" })).toBe("out");
    expect(resultText({ experimental_content: [{ type: "text", text: "x" }] })).toBe("x");
  });
  it("isErrorResult reads the high-level flag", () => {
    expect(
      isErrorResult({
        providerOptions: { cursor: { highLevelToolCallResult: { isError: true } } },
      }),
    ).toBe(true);
    expect(isErrorResult({})).toBe(false);
  });
  it("userQueryText unwraps <user_query>, else trims", () => {
    expect(userQueryText("<timestamp>t</timestamp>\n<user_query>\nDo X\n</user_query>")).toBe(
      "Do X",
    );
    expect(userQueryText("  plain  ")).toBe("plain");
  });
});

// ── protobuf DAG root ─────────────────────────────────────────────────────────
function root(msgIds, cwdUri) {
  const parts = [];
  for (const id of msgIds) parts.push(Buffer.from([0x0a, 0x20]), Buffer.from(id, "hex")); // field 1, len 32
  if (cwdUri) {
    const u = Buffer.from(cwdUri, "utf8");
    parts.push(Buffer.from([0x4a, u.length]), u); // field 9, wt 2; len < 128
  }
  return Buffer.concat(parts);
}
const ID = (n) => n.toString(16).padStart(2, "0").repeat(32); // 64-hex = 32 bytes

describe("scanRoot", () => {
  it("extracts field-1 32-byte ids in order + field-9 cwd", () => {
    const ids = [ID(0xa1), ID(0xb2), ID(0xc3)];
    const { ids: got, cwd } = scanRoot(root(ids, "file:///tmp/proj"));
    expect(got).toEqual(ids);
    expect(cwd).toBe("/tmp/proj");
  });
});

// ── full history parse (needs node:sqlite) ────────────────────────────────────
it.skipIf(!DatabaseSync)(
  "getEvents walks the DAG → user/tool/assistant timeline (skips system, injected, redacted-reasoning)",
  async () => {
    const ids = [ID(1), ID(2), ID(3), ID(4), ID(5), ID(6)];
    const rootId = ID(0x0f);
    const messages = [
      { role: "system", content: "You are Composer." },
      { role: "user", content: "<user_info>injected context</user_info>" },
      {
        role: "user",
        content: [{ type: "text", text: "<user_query>\nList the files\n</user_query>" }],
      },
      {
        role: "assistant",
        id: "1",
        content: [
          { type: "redacted-reasoning", data: "opaque" },
          { type: "tool-call", toolCallId: "t1", toolName: "Shell", args: { command: "ls -a" } },
        ],
      },
      {
        role: "tool",
        id: "t1",
        content: [
          {
            type: "tool-result",
            toolCallId: "t1",
            toolName: "Shell",
            result: "Exit code: 0\n\nfoo\nbar\n",
          },
        ],
      },
      {
        role: "assistant",
        id: "1",
        content: [
          { type: "redacted-reasoning", data: "opaque2" },
          { type: "text", text: "There are two files: foo and bar." },
        ],
      },
    ];
    const dir = mkdtempSync(path.join(tmpdir(), "cursor-store-"));
    try {
      const dbPath = path.join(dir, "store.db");
      const db = new DatabaseSync(dbPath);
      db.exec(
        "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)",
      );
      const meta = {
        agentId: "chat-1",
        latestRootBlobId: rootId,
        name: "New Agent",
        mode: "default",
        createdAt: 1700000000000,
      };
      db.prepare("INSERT INTO meta (key, value) VALUES ('0', ?)").run(
        Buffer.from(JSON.stringify(meta), "utf8").toString("hex"),
      );
      const ins = db.prepare("INSERT INTO blobs (id, data) VALUES (?, ?)");
      ids.forEach((id, i) => ins.run(id, Buffer.from(JSON.stringify(messages[i]), "utf8")));
      ins.run(rootId, root(ids, "file:///tmp/proj"));
      db.close();

      const a = new CursorAdapter({ turns: { isRunning: () => false } });
      a._loc.set("chat-1", dbPath); // resolve without scanning ~/.cursor
      const events = await a.getEvents("chat-1");

      expect(events.map((e) => e.type)).toEqual([
        "user_message",
        "tool_call",
        "tool_result",
        "assistant_message",
      ]);
      expect(events[0].text).toBe("List the files");
      expect(events[1].call).toMatchObject({ name: "shell", input: { command: "ls -a" } });
      expect(events[2].result.content.text).toContain("foo");
      expect(events[3].text).toBe("There are two files: foo and bar.");
      expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

// ── getActivity mtime fallback (needs node:sqlite) ────────────────────────────
it.skipIf(!DatabaseSync)(
  "getActivity: unknown liveness falls back to the mtime window (fresh → running, stale → completed)",
  async () => {
    const rootId = ID(0x0f);
    const dir = mkdtempSync(path.join(tmpdir(), "cursor-act-"));
    try {
      const dbPath = path.join(dir, "store.db");
      const db = new DatabaseSync(dbPath);
      db.exec(
        "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)",
      );
      const meta = { agentId: "chat-a", latestRootBlobId: rootId, createdAt: 1700000000000 };
      db.prepare("INSERT INTO meta (key, value) VALUES ('0', ?)").run(
        Buffer.from(JSON.stringify(meta), "utf8").toString("hex"),
      );
      db.prepare("INSERT INTO blobs (id, data) VALUES (?, ?)").run(
        rootId,
        root([], "file:///tmp/proj"),
      );
      db.close();

      const a = new CursorAdapter({ turns: { isRunning: () => false } });
      a._loc.set("chat-a", dbPath);
      // Just-written store, liveness unknown → running (the Windows-safe fallback).
      expect((await a.getActivity("chat-a")).activity).toBe("running");
      // Backdate the store beyond the window → completed.
      const old = new Date(Date.now() - 10 * 60_000);
      utimesSync(dbPath, old, old);
      expect((await a.getActivity("chat-a")).activity).toBe("completed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

// ── live stream parse (mocked spawn) ──────────────────────────────────────────
function makeChild() {
  const c = new EventEmitter();
  c.stdout = new PassThrough();
  c.stderr = new EventEmitter();
  c.kill = () => {};
  return c;
}

describe("startTurn stream parsing", () => {
  it("captures session id, streams thinking/tool/assistant, and does not double the aggregate", async () => {
    h.child = makeChild();
    const alias = vi.fn();
    const turns = {
      assertCapacity() {},
      register: () => ({ id: 1 }),
      alias,
      release() {},
      isRunning: () => false,
    };
    const a = new CursorAdapter({ turns });
    const events = [];
    const { done } = a.startTurn({ threadId: null, text: "hi", cwd: null }, (e) => events.push(e));

    const lines = [
      { type: "system", subtype: "init", session_id: "sess-1", cwd: "/tmp", model: "Auto" },
      {
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
        session_id: "sess-1",
      },
      { type: "thinking", subtype: "delta", text: "Think", session_id: "sess-1", timestamp_ms: 1 },
      { type: "thinking", subtype: "completed", session_id: "sess-1" },
      {
        type: "tool_call",
        subtype: "started",
        call_id: "c1",
        tool_call: { shellToolCall: { args: { command: "echo hi" } } },
      },
      {
        type: "tool_call",
        subtype: "completed",
        call_id: "c1",
        tool_call: {
          shellToolCall: { args: { command: "echo hi" }, result: { success: { stdout: "hi\n" } } },
        },
      },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "He" }] },
        session_id: "sess-1",
        timestamp_ms: 2,
      },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "llo" }] },
        session_id: "sess-1",
        timestamp_ms: 3,
      },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "Hello" }] },
        session_id: "sess-1",
      },
      {
        type: "result",
        subtype: "success",
        result: "Hello",
        is_error: false,
        session_id: "sess-1",
      },
    ];
    for (const l of lines) h.child.stdout.write(JSON.stringify(l) + "\n");
    await new Promise((r) => {
      h.child.stdout.on("end", r);
      h.child.stdout.end();
    });
    await new Promise((r) => setImmediate(r));
    h.child.emit("close", 0);
    const realId = await done;

    expect(realId).toBe("sess-1");
    expect(alias).toHaveBeenCalledWith(expect.anything(), "cursor", "sess-1");
    expect(events.filter((e) => e.type === "user_message").map((e) => e.text)).toEqual(["hi"]);
    expect(events.some((e) => e.type === "thinking_finished" && e.text === "Think")).toBe(true);

    const calls = events.filter((e) => e.type === "tool_call");
    expect(calls[0].call).toMatchObject({
      name: "shell",
      input: { command: "echo hi" },
      status: "running",
    });
    expect(calls.at(-1).call.status).toBe("success");
    expect(events.find((e) => e.type === "tool_result").result.content.text).toBe("hi\n");

    const asst = events.filter((e) => e.type === "assistant_message").map((e) => e.text);
    expect(asst.at(-1)).toBe("Hello");
    expect(asst).not.toContain("HelloHello"); // the delta-vs-aggregate bug
  });
});

// ── JSONL fallback store (no sqlite needed) ───────────────────────────────────
describe("JSONL transcript fallback", () => {
  // Verbatim shape from ~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl
  // (cursor-agent 2026.07.16): AI-SDK-ish messages, reasoning replaced by the
  // literal "[REDACTED]", tool calls with no results, and a turn_ended trailer.
  const LINES = [
    {
      role: "user",
      message: {
        content: [
          {
            type: "text",
            text: "<timestamp>Friday, Jul 17, 2026, 2:27 PM</timestamp>\n<user_query>\nRun 'cat note.txt' and summarise it.\n</user_query>",
          },
        ],
      },
    },
    {
      role: "assistant",
      message: {
        content: [
          { type: "text", text: "[REDACTED]" },
          {
            type: "tool_use",
            id: "call-1",
            name: "Shell",
            input: { command: "cat note.txt", working_directory: "/tmp/proj" },
          },
        ],
      },
    },
    {
      role: "assistant",
      message: { content: [{ type: "text", text: 'It says "hello".\n\n[REDACTED]' }] },
    },
    { type: "turn_ended", status: "success" },
  ];

  /** Lay the file out exactly as cursor does, so path handling is under test too. */
  function transcriptDir(chatId) {
    const root = mkdtempSync(path.join(tmpdir(), "cursor-tx-"));
    const dir = path.join(root, "slug", "agent-transcripts", chatId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, `${chatId}.jsonl`),
      LINES.map((l) => JSON.stringify(l)).join("\n"),
    );
    return { root, file: path.join(dir, `${chatId}.jsonl`) };
  }

  it("renders a transcript with no sqlite at all", () => {
    const { root, file } = transcriptDir("chat-tx");
    try {
      const a = new CursorAdapter({ turns: { isRunning: () => false } });
      const { events, cwd, preview } = a._readTranscript(file, "chat-tx");
      expect(events.map((e) => e.type)).toEqual(["user_message", "tool_call", "assistant_message"]);
      // The <user_query> envelope is unwrapped and the timestamp header dropped.
      expect(events[0].text).toBe("Run 'cat note.txt' and summarise it.");
      expect(preview).toBe("Run 'cat note.txt' and summarise it.");
      expect(events[1].call).toMatchObject({ name: "Shell", input: { command: "cat note.txt" } });
      // "[REDACTED]" marks removed reasoning — never shown as assistant prose.
      expect(events[2].text).toBe('It says "hello".');
      expect(events.some((e) => e.text?.includes("REDACTED"))).toBe(false);
      // The only place a cwd appears in this store.
      expect(cwd).toBe("/tmp/proj");
      expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("serves getEvents from the transcript when the db can't be opened", async () => {
    const { root, file } = transcriptDir("chat-tx");
    try {
      const a = new CursorAdapter({ turns: { isRunning: () => false } });
      a._sqlite = null; // a host with neither node:sqlite nor bun:sqlite
      a._txLoc.set("chat-tx", file);
      const events = await a.getEvents("chat-tx");
      expect(events.map((e) => e.type)).toEqual(["user_message", "tool_call", "assistant_message"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("drops a transcript with no user turn rather than listing an empty thread", () => {
    const root = mkdtempSync(path.join(tmpdir(), "cursor-tx-"));
    try {
      const dir = path.join(root, "slug", "agent-transcripts", "empty");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "empty.jsonl"), JSON.stringify(LINES[3]));
      const a = new CursorAdapter({ turns: { isRunning: () => false } });
      expect(a._readTranscript(path.join(dir, "empty.jsonl"), "empty").preview).toBe(null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
