import { describe, expect, it } from "vitest";
import type {
  CreateRunResponse,
  WireEnvelope,
} from "@pounce/shared";
import { PounceAdapter } from "./pounceAdapter";
import type { Transport } from "../transport/types";

function env(seq: number, payload: WireEnvelope["payload"]): WireEnvelope {
  return { seq, runId: "run1", ts: seq * 1000, payload };
}

/** A transport stub that yields a fixed list of envelopes. */
function stubTransport(envelopes: WireEnvelope[]): Transport {
  return {
    kind: "http",
    connect: async () => ({}) as never,
    disconnect: async () => {},
    onStateChange: () => () => {},
    listAgents: async () => [],
    createRun: async () => ({}) as CreateRunResponse,
    controlRun: async () => {},
    async *subscribe() {
      for (const e of envelopes) yield e;
    },
    exec: async () => ({ terminalId: "t1" }),
    execWrite: async () => {},
    execResize: async () => {},
    execTerminate: async () => {},
    gitStatus: async () => ({}),
    gitDiff: async () => "",
    gitCommit: async () => {},
  };
}

async function collect(adapter: PounceAdapter, conv: string) {
  const out = [];
  for await (const batch of adapter.events(conv)) out.push(...batch);
  return out;
}

describe("PounceAdapter", () => {
  it("coalesces streaming assistant deltas into one growing message", async () => {
    const adapter = new PounceAdapter(
      stubTransport([
        env(1, { type: "UserEnvelope", message: "hi" }),
        env(2, { type: "ContentBlockDelta", index: 0, delta: { text: "Hel" } }),
        env(3, { type: "ContentBlockDelta", index: 0, delta: { text: "lo" } }),
      ]),
    );
    const events = await collect(adapter, "c1");
    const assistant = events.filter((e) => e.type === "assistant_message");
    expect(assistant.at(-1)).toMatchObject({ text: "Hello", streaming: true });
    // both deltas share one message id
    expect(new Set(assistant.map((e) => e.id)).size).toBe(1);
  });

  it("dedups already-applied seqs on resume overlap", async () => {
    const adapter = new PounceAdapter(
      stubTransport([
        env(1, { type: "UserEnvelope", message: "a" }),
        env(1, { type: "UserEnvelope", message: "a" }), // replayed dup
        env(2, { type: "UserEnvelope", message: "b" }),
      ]),
    );
    const events = await collect(adapter, "c1");
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
    expect(adapter.cursorFor("c1")).toBe(2);
  });

  it("degrades unknown wire types to system_event without throwing", async () => {
    const adapter = new PounceAdapter(
      stubTransport([env(1, { type: "SomeFutureVariant", foo: 1 })]),
    );
    const events = await collect(adapter, "c1");
    expect(events[0]).toMatchObject({
      type: "system_event",
      source: "SomeFutureVariant",
    });
  });
});
