/**
 * AgentHost — the bridge's native agent backend. A registry of
 * per-agent adapters (session reading + turn execution) behind one facade with
 * the semantics server.mjs has always exposed over HTTP.
 *
 * Memory model: adapters keep metadata-only session indexes; parsed histories
 * live in one shared bounded LRU, invalidated by each adapter's fs watcher the
 * moment a transcript changes.
 */
import os from "node:os";
import { TurnManager } from "./turn-manager.mjs";
import { HistoryCache, eventBytes } from "./history-cache.mjs";
import { ClaudeAdapter } from "./claude.mjs";
import { CodexAdapter } from "./codex.mjs";
import { OpencodeAdapter } from "./opencode.mjs";
import { CursorAdapter } from "./cursor.mjs";
import { canonicalAdapters } from "./canonical.mjs";
import { acpAvailable, startAcpTurn } from "./acp.mjs";
import { threadCost } from "./ccusage.mjs";
import { buildDoctorReport } from "./doctor.mjs";
import { bridgeId } from "./identity.mjs";

export function createHost({ version = () => null } = {}) {
  const turns = new TurnManager();
  const history = new HistoryCache();
  const startedAt = Date.now();

  const adapters = new Map();
  for (const A of [ClaudeAdapter, CodexAdapter, OpencodeAdapter, CursorAdapter]) {
    const a = new A({ turns });
    adapters.set(a.id, a);
    a.onDirty?.((threadId) => history.invalidatePrefix(`${a.id}:${threadId}:`));
  }
  // Read-only history for the long tail (gemini, qwen, goose, cline, copilot,
  // pi, droid, vibe, kilo), parsed by `agent-canonical`. Registered ONLY for
  // dialects with sessions on this machine, so nobody grows an agent list full
  // of CLIs they don't run — and each is best-effort: see canonical.mjs.
  for (const a of canonicalAdapters()) {
    if (!adapters.has(a.id)) adapters.set(a.id, a);
  }

  const adapter = (agent) => {
    const a = adapters.get(agent);
    if (!a) throw new Error(`unknown agent: ${agent}`);
    return a;
  };

  return {
    /** AgentInfo list, same shape the app already consumes via /v1/agents. */
    async getAgents() {
      return Promise.all(
        [...adapters.values()].map(async (a) => ({
          id: a.id,
          displayName: a.displayName,
          available: await a.isAvailable().catch(() => false),
          wire: "jsonl",
          description: a.description || "",
          capabilities: a.capabilities,
        })),
      );
    },

    /** Host status, shape-stable for the app's device card. nodeId/relay are
     *  null here — off-LAN identity is served by /v1/pair from the tunnel. */
    status() {
      return {
        pid: process.pid,
        version: version() || "native",
        nodeId: null,
        relay: null,
        uptimeSecs: Math.round((Date.now() - startedAt) / 1000),
        device: os.hostname().replace(/\.local$/, ""),
        // Which MACHINE this is, as opposed to `device` (a display name two
        // machines can share) or the address the client happened to reach it
        // at. The apps key paired devices off this — see agents/identity.mjs.
        bridgeId: bridgeId(),
      };
    },

    listThreads(agent) {
      return adapter(agent).listThreads();
    },

    async getEvents(agent, threadId, { limit, fresh } = {}) {
      const prefix = `${agent}:${threadId}:`;
      const key = `${prefix}${limit || "full"}`;
      if (fresh) history.invalidatePrefix(prefix);
      const hit = history.get(key);
      if (hit) return hit;
      const events = await adapter(agent).getEvents(threadId, { limit });
      history.set(key, events, eventBytes(events));
      return events;
    },

    getActivity(agent, threadId) {
      return adapter(agent).getActivity(threadId);
    },

    /** Per-thread token usage. Dollars come from the agent itself where it
     *  reports them (see ./usage.mjs); where it doesn't, ccusage's list-price
     *  estimate fills the hole, tagged so the UI can mark it as approximate.
     *
     *  The fill is deliberately only for `cost == null`. A partial official
     *  figure (a Claude thread with turns taken outside Pounce) keeps its own
     *  number and its `costComplete: false` marker rather than being replaced
     *  by an estimate — a real, incomplete number is not a gap. */
    async getUsage(agent, threadId) {
      const a = adapter(agent);
      if (!a.getUsage) return { available: false, reason: "unsupported-agent" };
      const usage = await a.getUsage(threadId);
      if (!usage?.available || usage.cost != null) return usage;
      const est = await threadCost(agent, threadId).catch(() => null);
      if (!est) return usage;
      return {
        ...usage,
        cost: Math.round(est.cost * 10000) / 10000,
        // ccusage reads the whole transcript, so unlike the ledger this covers
        // every turn in the thread — partial only in that it's priced, not billed.
        costComplete: true,
        costSource: "ccusage-est",
      };
    },

    /** On-disk transcript path for a thread, or null when the adapter keeps its
     *  history elsewhere (Cursor's SQLite store) or the file is gone. The
     *  activity index reads per-DAY token counts out of these — dates and token
     *  counts only, never a price (see ./activity-index.mjs).
     */
    async transcriptFile(agent, threadId) {
      const a = adapters.get(agent);
      if (!a?.findFile) return null;
      return a.findFile(threadId).catch(() => null);
    },

    /** Diagnostic report: node, agent CLIs, sessions, git, tunnel. */
    doctor() {
      return buildDoctorReport([...adapters.values()]);
    },

    /** Fetch one attachment's bytes ({ mediaType, buffer }) — null if the
     *  adapter doesn't support images or the ref is stale. */
    getImage(agent, threadId, ref) {
      const a = adapter(agent);
      return a.getImage ? a.getImage(threadId, ref) : Promise.resolve(null);
    },

    listModels(agent) {
      return adapter(agent).listModels();
    },

    /** Cheap stamp of an agent's model config, for cache keys — "" when the
     *  adapter has nothing to stamp, which just means a plain TTL. Never
     *  throws: it feeds a cache key, so an unknown agent must still reach
     *  listModels() and fail there, the way it always did. */
    modelsSignature(agent) {
      try {
        const a = adapter(agent);
        return a.modelsSignature ? a.modelsSignature() : "";
      } catch {
        return "";
      }
    },

    /** Run a turn; events flow to onEvent as they stream. Returns
     *  { stop(), done: Promise<realThreadId> }. Never throws synchronously in a
     *  way callers must handle — capacity/spawn failures surface as an error
     *  event plus an immediately-resolved done. */
    startTurn(agent, opts, onEvent = () => {}) {
      // Adapters may be async (pre-flight checks) — return a synchronous
      // {stop, done} facade regardless, and honor a stop() that lands before
      // the child has spawned.
      let inner = null,
        stopped = false;
      // Opt-in ACP transport (BRIDGE_ACP=1): drive the agent over the Agent
      // Client Protocol instead of its stream-json path — richer tool status,
      // plans, and permission prompts. Falls back to the adapter when the agent
      // has no ACP server available.
      const useAcp = process.env.BRIDGE_ACP === "1" && acpAvailable(agent);
      const runCli = () =>
        Promise.resolve(adapter(agent).startTurn(opts, onEvent)).then((t) => {
          inner = t;
          if (stopped) t.stop();
          return t.done;
        });
      const runAcp = () =>
        Promise.resolve(startAcpTurn(agent, opts, onEvent)).then((t) => {
          inner = t;
          if (stopped) t.stop();
          // ACP rejects `done` ONLY for pre-stream failures (adapter startup
          // crash, e.g. a bundled runtime dep missing) — retry over the agent's
          // classic CLI transport so the user's turn still runs. Mid-turn ACP
          // failures resolve with their own error event and don't retry.
          return t.done.catch((e) => {
            if (stopped) throw e;
            console.log(
              `[acp] ${agent} pre-stream failure — falling back to CLI transport: ${String(e?.message || e).slice(0, 300)}`,
            );
            return runCli();
          });
        });
      const done = Promise.resolve()
        .then(() => (useAcp ? runAcp() : runCli()))
        .then(
          // A finished turn changed its thread's history — drop stale parses
          // now rather than waiting on the fs watcher's debounce.
          (realId) => {
            history.invalidatePrefix(`${agent}:${realId}:`);
            return realId;
          },
          (e) => {
            try {
              onEvent({
                id: `${opts.threadId || agent}:err`,
                conversationId: opts.threadId || null,
                seq: 1,
                ts: new Date().toISOString(),
                type: "system_event",
                message: String(e?.message || e),
                level: "error",
              });
            } catch {}
            return opts.threadId || null;
          },
        );
      return {
        stop: () => {
          stopped = true;
          inner?.stop();
        },
        done,
      };
    },

    interrupt(agent, threadId) {
      return turns.interrupt(agent, threadId);
    },

    activeTurns() {
      return turns.count();
    },
  };
}
