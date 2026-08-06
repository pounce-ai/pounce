/**
 * The timeline vocabulary, checked against ACP in both directions.
 *
 * Every adapter re-derives the same handful of events from a different on-disk
 * format, and the live path (acp.mjs) receives them as ACP `session/update`
 * kinds. ACP_TO_EVENT / EVENT_TO_ACP are the one place that relationship is
 * written down, so these tests keep it honest: a protocol addition must be
 * classified rather than silently dropped, and an event we invent must either
 * have an ACP name or be a deliberate extension.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACP_TO_EVENT,
  EVENT_TO_ACP,
  assistantMessage,
  permissionRequest,
  systemEvent,
  thinking,
  toolCall,
  toolResult,
  userMessage,
} from "./events.mjs";

const BASE = { id: "e1", conversationId: "t1", seq: 1, ts: "2026-08-05T00:00:00.000Z" };

describe("timeline vocabulary", () => {
  it("names every event type the constructors emit", () => {
    const emitted = [
      userMessage(BASE, "hi"),
      assistantMessage(BASE, "yo"),
      thinking(BASE, "hmm"),
      toolCall(BASE, { name: "Read", input: {} }),
      toolResult(BASE, { toolCallId: "c1", content: { kind: "text", text: "ok" } }),
      systemEvent(BASE, "Context compacted", "info"),
      permissionRequest(BASE, { requestId: "r1", toolName: "Bash", options: [] }),
    ].map((e) => e.type);
    for (const type of emitted) expect(EVENT_TO_ACP).toHaveProperty(type);
    expect(Object.keys(EVENT_TO_ACP).sort()).toEqual([...new Set(emitted)].sort());
  });

  it("round-trips every kind that has a name on both sides", () => {
    for (const [kind, type] of Object.entries(ACP_TO_EVENT)) {
      if (type === null) continue;
      expect(EVENT_TO_ACP).toHaveProperty(type);
      // tool_call is the one many-to-one: plan and plan_update both render as a
      // tool card, so only the canonical kind maps back.
      if (EVENT_TO_ACP[type] === kind) continue;
      expect(["plan", "plan_update"]).toContain(kind);
    }
  });

  it("classifies every session/update kind the installed ACP SDK declares", () => {
    // Read the SDK's generated types rather than guessing: this is the drift
    // detector. Skips when the SDK isn't installed (it arrives transitively).
    const here = path.dirname(fileURLToPath(import.meta.url));
    const gen = path.resolve(
      here,
      "../../../node_modules/@agentclientprotocol/sdk/dist/schema/types.gen.d.ts",
    );
    if (!existsSync(gen)) return;
    const declared = [...readFileSync(gen, "utf8").matchAll(/sessionUpdate: "([a-z_]+)"/g)].map(
      (m) => m[1],
    );
    expect(declared.length).toBeGreaterThan(0);
    const unclassified = [...new Set(declared)].filter((k) => !(k in ACP_TO_EVENT));
    // A failure here means ACP grew an update kind. Decide what it is — a
    // timeline event or state — and add it to ACP_TO_EVENT.
    expect(unclassified).toEqual([]);
  });
});
