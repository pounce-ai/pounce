/**
 * TurnManager — registry of live agent-CLI children, one per running turn.
 * Owns interrupt semantics (SIGINT first so the CLI can persist its transcript,
 * SIGKILL 5s later) and the global concurrency cap.
 */
const MAX_CONCURRENT = 4;

export class TurnManager {
  constructor() {
    this.turns = new Map(); // "agent:threadId" -> entry; several keys may share one entry
  }

  key(agent, threadId) {
    return `${agent}:${threadId}`;
  }

  count() {
    return new Set(this.turns.values()).size;
  }

  /** Throws when the host is already saturated — callers surface it as an event. */
  assertCapacity() {
    if (this.count() >= MAX_CONCURRENT) {
      throw new Error(`too many concurrent turns (max ${MAX_CONCURRENT})`);
    }
  }

  /** Track a child under one or more thread ids (provisional + real). */
  register(agent, threadIds, child) {
    const entry = { child, agent, startedAt: Date.now(), keys: new Set() };
    for (const id of threadIds) {
      if (!id) continue;
      const k = this.key(agent, id);
      entry.keys.add(k);
      this.turns.set(k, entry);
    }
    return entry;
  }

  /** A fresh turn learned its real thread id — index it under that too. */
  alias(entry, agent, threadId) {
    if (!threadId) return;
    const k = this.key(agent, threadId);
    entry.keys.add(k);
    this.turns.set(k, entry);
  }

  release(entry) {
    for (const k of entry.keys) {
      if (this.turns.get(k) === entry) this.turns.delete(k);
    }
  }

  isRunning(agent, threadId) {
    return this.turns.has(this.key(agent, threadId));
  }

  /** SIGINT (graceful — the CLI persists its transcript), SIGKILL after 5s. */
  interrupt(agent, threadId) {
    const entry = this.turns.get(this.key(agent, threadId));
    if (!entry) return false;
    kill(entry.child, "SIGINT");
    const hard = setTimeout(() => kill(entry.child, "SIGKILL"), 5000);
    entry.child.once("close", () => clearTimeout(hard));
    if (entry.child.exitCode !== null) clearTimeout(hard); // already gone
    return true;
  }
}

function kill(child, sig) {
  try {
    child.kill(sig);
  } catch {}
}
