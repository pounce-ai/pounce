/**
 * ACP (Agent Client Protocol) turn runner — a single client that drives any
 * ACP-speaking agent and maps its structured `session/update` stream onto the
 * app's timeline events. This is what gives Pounce-initiated live turns the
 * things `--stream-json` can't: real tool status, plans, and (M2) interactive
 * permission prompts.
 *
 * Agent-agnostic: each agent just declares HOW to spawn its ACP server.
 *   - claude   → node <@agentclientprotocol/claude-agent-acp>
 *   - codex    → node <@agentclientprotocol/codex-acp>
 *   - opencode → `opencode acp` (native)
 * All three then speak the same protocol, so the mapping below is shared.
 *
 * ACP session ids ARE the agents' transcript ids (verified for claude), so a
 * fresh turn's sessionId becomes the Pounce threadId with no reconciliation.
 *
 * Opt-in via BRIDGE_ACP=1 (dev/local bridge, where node_modules exists). The
 * bundled desktop bridge keeps the stream-json path until the adapters ship
 * with it.
 */
import { spawn, spawnSync } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { client, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import {
  assistantMessage,
  permissionRequest,
  systemEvent,
  thinking,
  toolCall,
  toolResult,
} from "./events.mjs";
import { agentEnv, binPath } from "./env.mjs";
import { binOverride } from "./config.mjs";

const require = createRequire(import.meta.url);

/**
 * Pending interactive permission prompts, keyed by requestId. When the agent
 * asks (session/request_permission), the runner parks a resolver here and emits
 * a permission_request event; the app POSTs its choice to /v1/turn/permission,
 * which calls resolvePermission() to unpark the turn. Auto-cancelled if the
 * turn ends first.
 */
const pendingPermissions = new Map();

/** Resolve a parked permission prompt with the app's chosen option (or null to
 *  cancel). Returns true if a matching prompt was waiting. */
export function resolvePermission(requestId, optionId) {
  const entry = pendingPermissions.get(requestId);
  if (!entry) return false;
  pendingPermissions.delete(requestId);
  entry.resolve(optionId);
  return true;
}

/** Per-agent: how to spawn its ACP server. `pkg` → `node <entry>` (bundled into
 *  Resources/bridge/adapters in the desktop app, else resolved from
 *  node_modules in dev); `cmd`+`args` → run directly (must be on PATH). */
const ADAPTERS = {
  claude: { pkg: "@agentclientprotocol/claude-agent-acp", bundle: "claude-agent-acp" },
  codex: { pkg: "@agentclientprotocol/codex-acp", bundle: "codex-acp" },
  opencode: { cmd: "opencode", args: ["acp"] },
};

function spawnSpec(agent) {
  const a = ADAPTERS[agent];
  if (!a) return null;
  if (a.pkg) {
    // Compiled single-file bridge (no node/node_modules on the host): re-invoke
    // ourselves in adapter mode. bridge-main.mjs routes `--acp-adapter <agent>`
    // to the ACP adapter embedded in the binary (scripts/bridge/compile.mjs).
    if (process.env.POUNCE_COMPILED === "1") {
      return { command: process.execPath, args: ["--acp-adapter", agent] };
    }
    // Prefer the adapter bundled beside this launcher (the packaged desktop app
    // has no node_modules); fall back to node_modules resolution in dev.
    const bundled = new URL(`./adapters/${a.bundle}.mjs`, import.meta.url).pathname;
    if (existsSync(bundled)) return { command: process.execPath, args: [bundled] };
    let entry;
    try {
      entry = require.resolve(a.pkg);
    } catch {
      return null;
    }
    return { command: process.execPath, args: [entry] };
  }
  // Direct-CLI adapter (opencode) — honor a user-pinned binary path.
  return { command: binPath(a.cmd), args: a.args || [] };
}

/** Whether an ACP turn can run for this agent right now. */
export function acpAvailable(agent) {
  return spawnSpec(agent) != null;
}

/** Resolve a binary's absolute path via the given env's PATH (sync, cheap). */
function resolveBin(name, env) {
  try {
    const r = spawnSync("/bin/sh", ["-c", `command -v ${name}`], { env, encoding: "utf8" });
    return r.stdout?.trim() || null;
  } catch {
    return null;
  }
}

/** Map an ACP tool_call kind → the app's tool naming (shell gets the $ chrome). */
function toolName(update) {
  const kind = update.kind || "";
  if (kind === "execute") return "shell";
  return update.title || kind || "tool";
}

/** Best-effort input preview for a tool call, matching what the app renders. */
function toolInput(update) {
  const raw = update.rawInput || {};
  if (typeof raw.command === "string") return { command: raw.command };
  if (Array.isArray(raw.command)) return { command: raw.command.join(" ") };
  for (const k of ["file_path", "path", "filePath"])
    if (typeof raw[k] === "string") return { [k]: raw[k] };
  // Fall back to the human title Claude/Codex already put on the call.
  return { command: update.title || "" };
}

const ACP_STATUS = {
  pending: "pending",
  in_progress: "running",
  completed: "success",
  failed: "error",
};

/** Flatten ACP tool-call `content` blocks into the app's tool_result content. */
function toolResultContent(content) {
  if (!Array.isArray(content)) return { kind: "text", text: "" };
  const parts = [];
  for (const c of content) {
    if (c?.type === "content" && c.content?.type === "text") parts.push(c.content.text);
    else if (c?.type === "text") parts.push(c.text);
    else if (c?.type === "diff" && c.newText != null) parts.push(c.newText);
  }
  return { kind: "text", text: parts.join("\n") };
}

/** ACP plan entries → the same `update_plan` shape Codex emits, so the app's
 *  task checklist + progress widget light up for ACP agents too. ACP's `plan` is
 *  a live task list (entries carry pending/in_progress/completed), NOT plan
 *  mode's proposal markdown — so it belongs in the checklist, not a PlanCard. */
function planSteps(entries) {
  return (entries || [])
    .filter((e) => typeof e?.content === "string" && e.content.trim())
    .map((e) => ({ step: e.content, status: e.status || "pending" }));
}

/**
 * Run one ACP turn. Mirrors the adapters' startTurn contract: returns
 * `{ stop, done }` where done resolves with the real thread id (= ACP session
 * id). Emits app timeline events through `onEvent`.
 */
/** Pounce PermissionMode → the ACP adapter's session mode id. Unset defaults to
 *  "default" (Manual) so the user gets interactive prompts — the adapter's own
 *  default is "auto" (silent-approve), which would bypass the whole point. */
const ACP_MODE = {
  default: "default",
  acceptEdits: "acceptEdits",
  bypassPermissions: "bypassPermissions",
  plan: "plan",
};

export function startAcpTurn(
  agent,
  { threadId, text, cwd, images, model, permissionMode },
  onEvent,
) {
  const spec = spawnSpec(agent);
  const fresh = !threadId || !/^[0-9a-f]{8}-/i.test(threadId);
  const dir = cwd && existsSync(cwd) ? cwd : process.env.HOME;

  const env = agentEnv();
  // The claude ACP adapter uses @anthropic-ai/claude-agent-sdk, which needs an
  // explicit path to the claude executable (it doesn't search PATH). When
  // bundled (desktop) the SDK's native binary isn't present, so point it at the
  // same claude the stream-json path uses.
  if (agent === "claude" && !env.CLAUDE_CODE_EXECUTABLE) {
    // A user-pinned claude path wins; otherwise resolve off PATH.
    const found = binOverride("claude") || resolveBin("claude", env);
    if (found) env.CLAUDE_CODE_EXECUTABLE = found;
  }
  // The codex ACP adapter spawns the codex CLI. Without CODEX_PATH it
  // require-resolves @openai/codex — a package the bundled (desktop) adapter
  // doesn't ship, which crashed every codex ACP turn with MODULE_NOT_FOUND.
  // Point it at the same codex the exec path uses.
  if (agent === "codex" && !env.CODEX_PATH) {
    const found = binOverride("codex") || resolveBin("codex", env);
    if (found) env.CODEX_PATH = found;
  }
  // Track whether anything streamed to the app: a failure BEFORE any output
  // means the adapter itself is broken (missing runtime dep, bad install) —
  // that class rejects `done` so the host falls back to the agent's classic
  // CLI transport instead of surfacing a dead turn.
  let emitted = false;
  const emitOut = onEvent;
  onEvent = (ev) => {
    emitted = true;
    emitOut(ev);
  };
  const child = spawn(spec.command, spec.args, {
    cwd: dir,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderrTail = "";
  child.stderr.on("data", (d) => {
    stderrTail = (stderrTail + d).slice(-4096);
  });

  const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
  const app = client({ name: "pounce-bridge", version: "0.1.0" });

  let seq = 0;
  const now = () => new Date().toISOString();
  const base = (id) => ({ id, conversationId: threadId || "acp", seq: ++seq, ts: now() });
  // Accumulate streamed text per messageId so each chunk updates one bubble.
  const acc = new Map();
  let forwarding = false; // ignore replayed history during session/load

  const onUpdate = (u) => {
    if (!forwarding) return;
    switch (u.sessionUpdate) {
      case "agent_message_chunk": {
        const key = u.messageId || `a:${seq}`;
        const t = (acc.get(key) || "") + (u.content?.type === "text" ? u.content.text : "");
        acc.set(key, t);
        onEvent(assistantMessage(base(key), t, true));
        break;
      }
      case "agent_thought_chunk": {
        const key = `think:${u.messageId || seq}`;
        const t = (acc.get(key) || "") + (u.content?.type === "text" ? u.content.text : "");
        acc.set(key, t);
        onEvent(thinking(base(key), t));
        break;
      }
      case "tool_call":
        onEvent(
          toolCall(base(u.toolCallId), {
            name: toolName(u),
            input: toolInput(u),
            status: ACP_STATUS[u.status] || "running",
          }),
        );
        break;
      case "tool_call_update":
        if (u.content?.length) {
          onEvent(
            toolResult(base(`${u.toolCallId}:o`), {
              toolCallId: u.toolCallId,
              content: toolResultContent(u.content),
              isError: u.status === "failed",
            }),
          );
        }
        break;
      case "plan": {
        const plan = planSteps(u.entries);
        if (plan.length) {
          onEvent(
            toolCall(base(`plan:${seq}`), {
              name: "update_plan",
              input: { plan },
              status: "success",
            }),
          );
        }
        break;
      }
      // available_commands_update / usage_update: not timeline events here.
    }
  };

  app.onNotification("session/update", (ctx) => {
    const u = ctx.params?.update;
    if (u?.sessionUpdate) {
      try {
        onUpdate(u);
      } catch {}
    }
  });
  const myRequests = new Set(); // requestIds parked by this turn (cleanup on stop)
  // Relay the prompt to the app and wait for its choice. A generous timeout
  // auto-allows so a disconnected / older client can't hang the turn forever.
  app.onRequest("session/request_permission", async (ctx) => {
    const opts = ctx.params?.options || [];
    if (!opts.length) return { outcome: { outcome: "cancelled" } };
    const allow =
      opts.find((o) => /allow/i.test(o.optionId) || /allow/i.test(o.name || "")) || opts[0];
    const requestId = randomUUID();
    myRequests.add(requestId);
    if (forwarding) {
      onEvent(
        permissionRequest(base(`perm:${requestId}`), {
          requestId,
          toolName: ctx.params?.toolCall?.kind || "tool",
          toolTitle: ctx.params?.toolCall?.title || "Run this tool?",
          options: opts.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
        }),
      );
    }
    const optionId = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (pendingPermissions.delete(requestId)) resolve(allow.optionId); // fallback
      }, 180_000).unref?.();
      pendingPermissions.set(requestId, {
        resolve: (id) => {
          clearTimeout(timer);
          resolve(id);
        },
      });
    });
    myRequests.delete(requestId);
    if (!optionId) return { outcome: { outcome: "cancelled" } };
    return { outcome: { outcome: "selected", optionId } };
  });

  let resolveDone, rejectDone;
  const done = new Promise((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });
  let realThreadId = threadId || null;
  let stopped = false;
  // Unpark any prompts still waiting (turn ended / interrupted) so their
  // promises don't leak and the ACP request gets a cancelled outcome.
  const cancelPending = () => {
    for (const id of myRequests) resolvePermission(id, null);
  };

  app
    .connectWith(stream, async (ctx) => {
      await ctx.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "pounce-bridge", version: "0.1.0" },
      });
      // Resume an existing thread via session/load; else a fresh session. Loading
      // replays history as updates — gate forwarding until the prompt so only the
      // new turn reaches the app.
      if (!fresh) {
        try {
          await ctx.request("session/load", { sessionId: threadId, cwd: dir, mcpServers: [] });
          realThreadId = threadId;
        } catch {
          const r = await ctx.request("session/new", { cwd: dir, mcpServers: [] });
          realThreadId = r.sessionId;
        }
      } else {
        const r = await ctx.request("session/new", { cwd: dir, mcpServers: [] });
        realThreadId = r.sessionId;
      }
      // Put the session in the requested permission mode (default = Manual, which
      // prompts). Best-effort — older adapters may not support session/set_mode.
      try {
        await ctx.request("session/set_mode", {
          sessionId: realThreadId,
          modeId: ACP_MODE[permissionMode] || "default",
        });
      } catch {}
      const content = [{ type: "text", text }];
      for (const img of images || []) {
        if (img?.data)
          content.push({ type: "image", mimeType: img.mediaType || "image/png", data: img.data });
      }
      forwarding = true;
      await ctx.request("session/prompt", { sessionId: realThreadId, prompt: content });
    })
    .then(() => {
      cancelPending();
      try {
        child.kill();
      } catch {}
      resolveDone(realThreadId);
    })
    .catch((e) => {
      cancelPending();
      try {
        child.kill();
      } catch {}
      if (!stopped && !emitted) {
        // Nothing reached the app — adapter startup failure. Reject so the
        // host retries the turn over the agent's classic CLI transport.
        rejectDone(
          new Error(
            `ACP failed pre-stream: ${e?.message || e}${stderrTail ? ` — ${stderrTail.trim().slice(-200)}` : ""}`,
          ),
        );
        return;
      }
      if (!stopped) {
        onEvent(
          systemEvent(
            base(`${realThreadId || "acp"}:err`),
            `ACP turn failed: ${e?.message || e}${stderrTail ? ` — ${stderrTail.trim().slice(-200)}` : ""}`,
            "error",
          ),
        );
      }
      resolveDone(realThreadId); // resolve (not reject) so the SSE closes cleanly
    });

  return {
    stop: () => {
      stopped = true;
      cancelPending();
      try {
        child.kill("SIGTERM");
      } catch {}
    },
    done,
  };
}
