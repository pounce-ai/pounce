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
import { acpAvailable, startAcpTurn } from "./acp.mjs";
import { buildDoctorReport } from "./doctor.mjs";

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

    /** Per-thread token usage, and cost only where the agent itself reports it
     *  (see ./usage.mjs). Adapters without a usage source say so rather than
     *  having the bridge estimate one. */
    getUsage(agent, threadId) {
      const a = adapter(agent);
      return a.getUsage
        ? a.getUsage(threadId)
        : Promise.resolve({ available: false, reason: "unsupported-agent" });
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
