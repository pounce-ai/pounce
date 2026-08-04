/**
 * isForeignWriter guards the resume path: resuming a session another process
 * is mid-turn on forks a live agent, which surfaces as a duplicate thread and
 * strands the sender's message.
 *
 * getActivity can't be trusted for this — judgeTranscript calls an assistant
 * turn ending in TEXT "completed" whatever its age, so an agent paused between
 * prose and its next tool call is indistinguishable from a finished one. These
 * tests pin the stricter rule: recency of the write decides, and only our own
 * turns are exempt.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeAdapter } from "./claude.mjs";

let dir;
let file;

/** Point the adapter at a transcript we control, bypassing the ~/.claude scan. */
function adapterFor(file, { isRunning = false } = {}) {
  const a = new ClaudeAdapter({ turns: { isRunning: () => isRunning } });
  a.findFile = async () => file;
  return a;
}

/** An assistant turn ending in TEXT — the shape getActivity calls "completed". */
const TEXT_TAIL = JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "text", text: "some prose" }] },
});

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "pounce-foreign-"));
  file = path.join(dir, "thread.jsonl");
  writeFileSync(file, TEXT_TAIL + "\n");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Backdate the transcript so it falls outside the write window. */
function ageFile(seconds) {
  const t = new Date(Date.now() - seconds * 1000);
  utimesSync(file, t, t);
}

describe("isForeignWriter", () => {
  it("flags a transcript being written right now, despite a 'completed' tail", async () => {
    expect(await adapterFor(file).isForeignWriter("t1")).toBe(true);
  });

  it("ignores a transcript nobody has touched in a while", async () => {
    ageFile(600);
    expect(await adapterFor(file).isForeignWriter("t1")).toBe(false);
  });

  it("does not flag writes from a turn we just ran", async () => {
    const a = adapterFor(file);
    a.ownWrites.set("t1", Date.now());
    expect(await a.isForeignWriter("t1")).toBe(false);
  });

  it("treats a long-past turn of ours as no longer ours", async () => {
    const a = adapterFor(file);
    a.ownWrites.set("t1", Date.now() - 10 * 60_000);
    expect(await a.isForeignWriter("t1")).toBe(true);
  });

  it("defers to turns.isRunning for our own in-flight turn", async () => {
    expect(await adapterFor(file, { isRunning: true }).isForeignWriter("t1")).toBe(false);
  });

  it("says no when the thread has no transcript at all", async () => {
    const a = adapterFor(null);
    expect(await a.isForeignWriter("missing")).toBe(false);
  });
});
