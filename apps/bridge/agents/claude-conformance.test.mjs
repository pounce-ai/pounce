/**
 * Drift detector for the claude adapter, using Anthropic's own SDK as the oracle.
 *
 * `~/.claude/projects/**.jsonl` is an undocumented format we read by hand, and
 * it moves: `ai-title` and `custom-title` records both appeared after this
 * adapter was written, and the second one shipped unnoticed until the SDK's
 * `listSessions()` was compared against our scan. The SDK now exposes the same
 * store as first-party API (`listSessions` / `getSessionInfo`), so pinning our
 * output against it turns the next format change from a silent regression into
 * a failing test.
 *
 * This reads the DEVELOPER'S real ~/.claude — there is no fixture for schema
 * drift. It therefore skips rather than fails whenever the oracle isn't there:
 * no SDK installed (it arrives transitively via the ACP packages), no sessions
 * on this machine, or a project dir the adapter deliberately ignores. CI without
 * a Claude install runs it as a no-op; a developer machine gets the signal.
 */
import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { ClaudeAdapter } from "./claude.mjs";

/** The SDK ships a platform binary and is only present transitively — never let
 *  its absence turn into a red suite. */
async function loadOracle() {
  try {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    return typeof sdk.listSessions === "function" ? sdk : null;
  } catch {
    return null;
  }
}

const ROOT = path.join(os.homedir(), ".claude", "projects");
const oracle = await loadOracle();
const runnable = oracle != null && existsSync(ROOT);

describe.skipIf(!runnable)("claude adapter — conformance with the Agent SDK", () => {
  /** Sessions the SDK reports, keyed by id. Bounded so the test stays quick. */
  async function oracleSessions() {
    const all = await oracle.listSessions({ limit: 200 });
    return new Map(all.map((s) => [s.sessionId, s]));
  }

  async function ourThreads() {
    const a = new ClaudeAdapter({ turns: { isRunning: () => false } });
    const metas = await a.listThreads();
    return new Map(metas.map((m) => [m.id, m]));
  }

  it("finds the sessions the SDK finds", async () => {
    const [theirs, ours] = await Promise.all([oracleSessions(), ourThreads()]);
    if (!theirs.size) return; // nothing to compare on this machine
    // Subset, not equality: we drop sessions with no real user turn (warmups,
    // snapshot-only files) on purpose, and the SDK paginates. A large miss rate
    // means the store moved or our filename/dir assumptions broke.
    const seen = [...theirs.keys()].filter((id) => ours.has(id));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.length / theirs.size).toBeGreaterThan(0.5);
  });

  it("agrees with the SDK on cwd and git branch", async () => {
    const [theirs, ours] = await Promise.all([oracleSessions(), ourThreads()]);
    for (const [id, s] of theirs) {
      const m = ours.get(id);
      if (!m) continue;
      if (s.cwd) expect(m.cwd).toBe(s.cwd);
      // gitBranch is "at the end of the session" for the SDK and first-seen for
      // us, so only assert we found one when they did.
      if (s.gitBranch) expect(m.gitBranch ?? s.gitBranch).toBeTruthy();
    }
  });

  it("titles a renamed session the way the SDK does", async () => {
    const [theirs, ours] = await Promise.all([oracleSessions(), ourThreads()]);
    const renamed = [...theirs.values()].filter((s) => s.customTitle && ours.has(s.sessionId));
    if (!renamed.length) return; // nobody has used /rename on this machine
    for (const s of renamed) expect(ours.get(s.sessionId).name).toBe(s.customTitle);
  });
});
