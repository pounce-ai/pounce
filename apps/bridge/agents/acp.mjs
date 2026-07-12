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
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { client, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { assistantMessage, systemEvent, thinking, toolCall, toolResult } from "./events.mjs";
import { agentEnv } from "./env.mjs";

const require = createRequire(import.meta.url);

/** Per-agent: how to spawn its ACP server. `pkg` → `node <resolved entry>`;
 *  `cmd`+`args` → run directly (must be on PATH). */
const ADAPTERS = {
  claude: { pkg: "@agentclientprotocol/claude-agent-acp" },
  codex: { pkg: "@agentclientprotocol/codex-acp" },
  opencode: { cmd: "opencode", args: ["acp"] },
};

function spawnSpec(agent) {
  const a = ADAPTERS[agent];
  if (!a) return null;
  if (a.pkg) {
    let entry;
    try { entry = require.resolve(a.pkg); } catch { return null; }
    return { command: process.execPath, args: [entry] };
  }
  return { command: a.cmd, args: a.args || [] };
}

/** Whether an ACP turn can run for this agent right now. */
export function acpAvailable(agent) {
  return spawnSpec(agent) != null;
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
  for (const k of ["file_path", "path", "filePath"]) if (typeof raw[k] === "string") return { [k]: raw[k] };
  // Fall back to the human title Claude/Codex already put on the call.
  return { command: update.title || "" };
}

const ACP_STATUS = { pending: "pending", in_progress: "running", completed: "success", failed: "error" };

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

/** Render an ACP structured plan as the markdown our PlanCard already shows. */
function planMarkdown(entries) {
  return (entries || [])
    .map((e, i) => `${i + 1}. ${e.status === "completed" ? "~~" : ""}${e.content}${e.status === "completed" ? "~~" : ""}`)
    .join("\n");
}

/**
 * Run one ACP turn. Mirrors the adapters' startTurn contract: returns
 * `{ stop, done }` where done resolves with the real thread id (= ACP session
 * id). Emits app timeline events through `onEvent`.
 */
export function startAcpTurn(agent, { threadId, text, cwd, images, model }, onEvent) {
  const spec = spawnSpec(agent);
  const fresh = !threadId || !/^[0-9a-f]{8}-/i.test(threadId);
  const dir = cwd && existsSync(cwd) ? cwd : process.env.HOME;

  const child = spawn(spec.command, spec.args, {
    cwd: dir,
    env: agentEnv(),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderrTail = "";
  child.stderr.on("data", (d) => { stderrTail = (stderrTail + d).slice(-4096); });

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
        onEvent(toolCall(base(u.toolCallId), {
          name: toolName(u), input: toolInput(u), status: ACP_STATUS[u.status] || "running",
        }));
        break;
      case "tool_call_update":
        if (u.content?.length) {
          onEvent(toolResult(base(`${u.toolCallId}:o`), {
            toolCallId: u.toolCallId, content: toolResultContent(u.content),
            isError: u.status === "failed",
          }));
        }
        break;
      case "plan":
        onEvent(toolCall(base(`plan:${seq}`), {
          name: "ExitPlanMode", input: { plan: planMarkdown(u.entries) }, status: "success",
        }));
        break;
      // available_commands_update / usage_update: not timeline events here.
    }
  };

  app.onNotification("session/update", (ctx) => {
    const u = ctx.params?.update;
    if (u?.sessionUpdate) { try { onUpdate(u); } catch {} }
  });
  // M1: auto-allow (prefer an "allow once" option). M2 relays this to the app.
  app.onRequest("session/request_permission", (ctx) => {
    const opts = ctx.params?.options || [];
    const pick = opts.find((o) => /allow/i.test(o.optionId) || /allow/i.test(o.name || "")) || opts[0];
    return { outcome: pick ? { outcome: "selected", optionId: pick.optionId } : { outcome: "cancelled" } };
  });

  let resolveDone, rejectDone;
  const done = new Promise((res, rej) => { resolveDone = res; rejectDone = rej; });
  let realThreadId = threadId || null;
  let stopped = false;

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
      const content = [{ type: "text", text }];
      for (const img of images || []) {
        if (img?.data) content.push({ type: "image", mimeType: img.mediaType || "image/png", data: img.data });
      }
      forwarding = true;
      await ctx.request("session/prompt", { sessionId: realThreadId, prompt: content });
    })
    .then(() => { try { child.kill(); } catch {} resolveDone(realThreadId); })
    .catch((e) => {
      try { child.kill(); } catch {}
      if (!stopped) {
        onEvent(systemEvent(base(`${realThreadId || "acp"}:err`),
          `ACP turn failed: ${e?.message || e}${stderrTail ? ` — ${stderrTail.trim().slice(-200)}` : ""}`, "error"));
      }
      resolveDone(realThreadId); // resolve (not reject) so the SSE closes cleanly
    });

  return {
    stop: () => { stopped = true; try { child.kill("SIGTERM"); } catch {} },
    done,
  };
}
