/**
 * The long-tail adapter's own layer: discovery, and the map from
 * agent-canonical's Session onto our timeline events.
 *
 * The Session fixture below is the real shape, captured by running their
 * claude-code parser over an actual 1104-message transcript — the same parser
 * family every long-tail dialect uses, so the mapping under test is the mapping
 * those CLIs will hit. Their PARSERS aren't retested here; that's their job, and
 * none of these CLIs is installed on a machine we can verify against.
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CanonicalAdapter, DIALECTS, eventsFor, metaFor, walk } from "./canonical.mjs";

const SESSION = {
  schemaVersion: 1,
  id: "pi--abc",
  cli: "pi",
  externalId: "abc",
  projectPath: "/Users/x/Projects/thing",
  gitBranch: "feat/x",
  model: "gpt-5.4",
  startedAt: "2026-08-01T10:00:00.000Z",
  endedAt: "2026-08-01T10:30:00.000Z",
  title: "Fix the thing",
  transcript: {
    messages: [
      { turn: 1, role: "user", text: "fix the thing", ts: "2026-08-01T10:00:00.000Z" },
      {
        turn: 2,
        role: "assistant",
        text: "I'll look.",
        ts: "2026-08-01T10:00:05.000Z",
        toolCalls: [
          {
            name: "Bash",
            args: { command: "ls" },
            callId: "call-1",
            outputPreview: "a.ts\nb.ts",
            exitCode: 0,
          },
        ],
      },
      {
        turn: 3,
        role: "assistant",
        text: "",
        toolCalls: [{ name: "Bash", args: { command: "false" }, outputFull: "boom", exitCode: 1 }],
      },
    ],
  },
};

describe("canonical → timeline mapping", () => {
  it("turns messages and their tool calls into ordered events", () => {
    const ev = eventsFor(SESSION, "t1");
    expect(ev.map((e) => e.type)).toEqual([
      "user_message",
      "assistant_message",
      "tool_call",
      "tool_result",
      "tool_call",
      "tool_result",
    ]);
    expect(ev.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(ev[0].text).toBe("fix the thing");
    expect(ev[2].call).toMatchObject({ name: "Bash", input: { command: "ls" } });
    expect(ev[3].result.content).toEqual({ kind: "text", text: "a.ts\nb.ts" });
  });

  it("marks a failed call from its exit code", () => {
    const ev = eventsFor(SESSION, "t1");
    expect(ev[4].call.status).toBe("error");
    expect(ev[5].result.isError).toBe(true);
    // outputFull is preferred over the truncated preview when present.
    expect(ev[5].result.content.text).toBe("boom");
  });

  it("emits no empty assistant bubble for a tools-only turn", () => {
    expect(eventsFor(SESSION, "t1").filter((e) => e.type === "assistant_message")).toHaveLength(1);
  });

  it("survives a session with nothing in it", () => {
    expect(eventsFor(null, "t1")).toEqual([]);
    expect(eventsFor({ transcript: { messages: [] } }, "t1")).toEqual([]);
  });

  it("takes thread meta from the session, not the filename", () => {
    const m = metaFor(SESSION, "abc", "/tmp/x.jsonl", { mtimeMs: 1, birthtimeMs: 1, size: 10 });
    expect(m).toMatchObject({
      id: "abc",
      cwd: "/Users/x/Projects/thing",
      name: "Fix the thing",
      gitBranch: "feat/x",
      createdAt: "2026-08-01T10:00:00.000Z",
      preview: "fix the thing",
    });
  });
});

describe("discovery", () => {
  it("finds matching transcripts through nested store layouts", () => {
    // e.g. pi's <cwd-slug>/<ts>_<id>.jsonl, or copilot's <id>/events.jsonl.
    const root = mkdtempSync(path.join(tmpdir(), "canon-"));
    try {
      mkdirSync(path.join(root, "slug", "deeper"), { recursive: true });
      writeFileSync(path.join(root, "slug", "a.jsonl"), "{}");
      writeFileSync(path.join(root, "slug", "deeper", "b.jsonl"), "{}");
      writeFileSync(path.join(root, "slug", "notes.txt"), "ignored");
      const found = walk(root, /\.jsonl$/).map((f) => path.basename(f.file));
      expect(found.sort()).toEqual(["a.jsonl", "b.jsonl"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns nothing for an absent store instead of throwing", () => {
    expect(walk("/nope/not/here", /\.jsonl$/)).toEqual([]);
  });
});

describe("adapter surface", () => {
  const adapter = () => new CanonicalAdapter(DIALECTS.find((d) => d.id === "pi"));

  it("never claims to be runnable", async () => {
    const a = adapter();
    expect(await a.isAvailable()).toBe(false);
    expect(a.capabilities.canTurn).toBe(false);
  });

  it("explains itself instead of hanging when a turn is sent anyway", async () => {
    const events = [];
    const t = adapter().startTurn({ threadId: "t1" }, (e) => events.push(e));
    await t.done;
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("system_event");
    expect(events[0].message).toMatch(/can't run turns/i);
  });

  it("reports no sessions when the store isn't there", () => {
    expect(adapter().hasSessions()).toBe(false);
  });
});
