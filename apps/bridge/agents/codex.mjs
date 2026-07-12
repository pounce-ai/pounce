/**
 * Codex CLI adapter — reads rollout transcripts from ~/.codex/sessions and
 * drives turns via `codex exec --json`.
 *
 * Rollout layout: ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl.
 * Line 1 is {type:"session_meta", payload:{id, cwd, ...}}; then
 * {type:"response_item"} (message / reasoning / function_call(+_output)) and
 * {type:"event_msg"} (task_started / task_complete / user_message / …).
 * ~/.codex/session_index.jsonl maps id -> thread_name (a free title index).
 */
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { stripNoise } from "@litter/transcript";
import { SessionIndex } from "./session-index.mjs";
import {
  userMessage, thinking, assistantMessage, toolCall, toolResult, systemEvent,
  readTailLines,
} from "./events.mjs";
import { agentEnv, binVersion, binPath } from "./env.mjs";

const ROOT = path.join(os.homedir(), ".codex", "sessions");
const INDEX_FILE = path.join(os.homedir(), ".codex", "session_index.jsonl");
const RUNNING_WINDOW_MS = 120_000;
const TURN_TIMEOUT_MS = Number(process.env.BRIDGE_TURN_TIMEOUT_MS || 300_000);
const FILE_RE = /^rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-([0-9a-f-]{36})\.jsonl$/;

export class CodexAdapter {
  constructor({ turns }) {
    this.id = "codex";
    this.displayName = "Codex";
    this.description = "OpenAI's Codex CLI";
    this.capabilities = { streaming: true, tools: true, images: false, thinking: true, terminal: true, git: true };
    this.turns = turns;
    this._titles = null; // id -> thread_name, lazily loaded from session_index.jsonl
    this.index = new SessionIndex({
      root: ROOT,
      match: (name) => FILE_RE.test(name),
      scanFile: (file, st) => this._scanRollout(file, st),
    });
  }

  onDirty(cb) { this.index.onDirty(cb); }

  async isAvailable() {
    // The binary must actually run — sessions on disk without a working CLI
    // can't take turns, matching the daemon's `available` semantics.
    return (await binVersion("codex")) != null;
  }

  titles() {
    // Small file (one line per session); re-read at most every 30s.
    if (this._titles && Date.now() - this._titles.at < 30_000) return this._titles.map;
    const map = new Map();
    try {
      for (const line of readFileSync(INDEX_FILE, "utf8").split("\n")) {
        if (!line) continue;
        try {
          const o = JSON.parse(line);
          if (o.id && o.thread_name) map.set(o.id, o.thread_name);
        } catch {}
      }
    } catch {}
    this._titles = { at: Date.now(), map };
    return map;
  }

  async listThreads() {
    const metas = await this.index.list();
    const titles = this.titles();
    for (const m of metas) m.name = titles.get(m.id) || m.name || null;
    return metas;
  }

  async findFile(threadId) {
    const meta = await this.index.get(threadId);
    return meta?.filePath && existsSync(meta.filePath) ? meta.filePath : null;
  }

  /** Meta from the filename (id, createdAt) + line 1 (cwd) + an early user message. */
  _scanRollout(file, st) {
    return new Promise((resolve) => {
      const m = FILE_RE.exec(path.basename(file));
      if (!m) return resolve(null);
      const id = m[2];
      // rollout-2026-03-21T16-58-58 → local timestamp; line 1's payload.timestamp is
      // authoritative when present.
      let createdAt = null, cwd = null, preview = null;
      let lines = 0;
      const stream = createReadStream(file, "utf8");
      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      const settle = () => {
        rl.close();
        stream.destroy();
        resolve({
          id, filePath: file, cwd, name: null, preview,
          createdAt: createdAt || new Date(st.birthtimeMs || st.mtimeMs).toISOString(),
          updatedAt: new Date(st.mtimeMs).toISOString(),
          gitBranch: null, sizeBytes: st.size,
        });
      };
      rl.on("line", (line) => {
        lines++;
        try {
          const o = JSON.parse(line);
          if (o.type === "session_meta") {
            cwd = o.payload?.cwd || null;
            createdAt = o.payload?.timestamp || o.timestamp || null;
          } else if (!preview && o.type === "event_msg" && o.payload?.type === "user_message") {
            const text = stripNoise(String(o.payload.message || ""), "codex").trim();
            if (text) preview = text.slice(0, 200);
          }
        } catch {}
        if ((cwd && preview) || lines > 60) settle();
      });
      rl.on("close", settle);
      stream.on("error", settle);
    });
  }

  async getEvents(threadId, { limit } = {}) {
    const file = await this.findFile(threadId);
    if (!file) return [];
    const turns = [];
    let cur = null;
    const add = (ev, startsTurn = false) => {
      if (startsTurn || !cur) { cur = []; turns.push(cur); }
      cur.push(ev);
      if (limit && turns.length > limit) turns.shift();
    };
    // Disambiguate colliding event ids. Codex parts without their own `p.id`
    // fall back to `<role>:<timestamp>`, and two parts can share a timestamp —
    // which produced two events with the same id and crashed the app's message
    // insert ("already exists"). The scan is deterministic over an append-only
    // rollout, so a per-id counter yields ids that are unique AND stable across
    // refetches. Only for messages/reasoning — tool-call ids are referenced by
    // their outputs (`${callId}:o`) and must stay paired, so leave those raw.
    const idCount = new Map();
    const uniq = (id) => {
      const n = idCount.get(id) || 0;
      idCount.set(id, n + 1);
      return n === 0 ? id : `${id}#${n}`;
    };

    let rl;
    try {
      rl = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
    } catch { return []; }
    for await (const line of rl) {
      if (!line) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      const ts = o.timestamp || new Date().toISOString();
      const p = o.payload || {};
      const base = (id) => ({ id, conversationId: threadId, seq: 0, ts });

      if (o.type === "response_item") {
        if (p.type === "message") {
          const text = (p.content || [])
            .map((c) => (c?.type === "input_text" || c?.type === "output_text" ? c.text || "" : ""))
            .join("");
          if (!text.trim()) continue;
          if (p.role === "assistant") add(assistantMessage(base(uniq(p.id || `a:${ts}`)), text));
          else if (p.role === "user") {
            const cleaned = stripNoise(text, "codex").trim();
            if (cleaned) add(userMessage(base(uniq(p.id || `u:${ts}`)), cleaned), true);
          }
          // developer role: injected instructions — skip.
        } else if (p.type === "reasoning") {
          const text = (p.summary || []).map((s) => s?.text || "").join("\n").trim();
          if (text) add(thinking(base(uniq(p.id || `r:${ts}`)), text));
        } else if (p.type === "function_call" || p.type === "custom_tool_call") {
          const callId = p.call_id || p.id || `c:${ts}`;
          add(toolCall(base(callId), codexCall(p)));
        } else if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
          const callId = p.call_id || `c:${ts}`;
          add(toolResult(base(`${callId}:o`), {
            toolCallId: callId,
            content: { kind: "text", text: codexOutput(p.output) },
            isError: false,
          }));
        }
        continue;
      }
      if (o.type === "event_msg" && p.type === "turn_aborted") {
        add(systemEvent(base(`ab:${ts}`), "Turn interrupted", "warning"));
      }
    }

    const events = turns.flat();
    events.forEach((ev, i) => { ev.seq = i + 1; });
    return events;
  }

  async getActivity(threadId) {
    if (this.turns.isRunning("codex", threadId)) {
      return { activity: "running", lastActivityAt: new Date().toISOString() };
    }
    const file = await this.findFile(threadId);
    if (!file) return { activity: "idle", lastActivityAt: null };
    let mtimeMs;
    try { mtimeMs = statSync(file).mtimeMs; } catch { return { activity: "idle", lastActivityAt: null }; }
    const lastActivityAt = new Date(mtimeMs).toISOString();
    const recent = Date.now() - mtimeMs < RUNNING_WINDOW_MS;
    // Last task marker wins: started-without-complete while fresh → running.
    for (const line of readTailLines(file).reverse()) {
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if (o.type !== "event_msg") continue;
      const t = o.payload?.type;
      if (t === "task_complete") return { activity: "completed", lastActivityAt };
      if (t === "turn_aborted") return { activity: "completed", lastActivityAt };
      if (t === "task_started") return { activity: recent ? "running" : "completed", lastActivityAt };
    }
    return { activity: "completed", lastActivityAt };
  }

  listModels() {
    // No daemon to ask and `codex exec` picks its own default; expose the
    // common choices. Harmless if the CLI knows more.
    return [
      { id: "gpt-5.2-codex", name: "GPT-5.2 Codex", description: null, isDefault: true, deprecated: false },
      { id: "gpt-5.1-codex-mini", name: "GPT-5.1 Codex Mini", description: null, isDefault: false, deprecated: false },
    ];
  }

  /**
   * `codex exec --json [resume <id>]` — emits JSONL: thread.started,
   * item.started/updated/completed (agent_message / reasoning /
   * command_execution / file_change / …), turn.completed / turn.failed.
   * NOTE: schema verified against docs, not a live binary (none on the dev
   * machine); parsing is defensive and history refetch backstops any gaps.
   */
  startTurn({ threadId, text, cwd, permissionMode, model }, onEvent) {
    this.turns.assertCapacity();
    const resume = threadId && /^[0-9a-f-]{36}$/i.test(threadId);
    const args = ["exec", "--json"];
    if (resume) args.push("resume", threadId);
    if (cwd && existsSync(cwd)) args.push("-C", cwd);
    if (model) args.push("-m", model);
    args.push(permissionMode === "bypassPermissions" ? "--dangerously-bypass-approvals-and-sandbox" : "--full-auto");
    args.push(text);

    let child;
    try {
      child = spawn(binPath("codex"), args, {
        cwd: cwd && existsSync(cwd) ? cwd : os.homedir(),
        env: agentEnv(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
      });
    } catch (e) {
      return failedTurn(threadId, `codex failed to start: ${e?.message || e}`, onEvent);
    }
    const entry = this.turns.register("codex", [threadId || "codex:pending"], child);

    let seq = 0;
    let realThreadId = threadId || null;
    const now = () => new Date().toISOString();
    const base = (id) => ({ id, conversationId: realThreadId, seq: ++seq, ts: now() });
    const emit = (ev) => { try { onEvent(ev); } catch {} };
    emit(userMessage(base(`codex:input:${Date.now()}`), text));

    let resolveDone;
    const done = new Promise((res) => { resolveDone = res; });
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      this.turns.release(entry);
      resolveDone(realThreadId || threadId || null);
    };

    let stderrTail = "";
    child.stderr.on("data", (d) => { stderrTail = (stderrTail + d).slice(-8192); });

    const handle = (o) => {
      if (o.type === "thread.started" && (o.thread_id || o.threadId)) {
        realThreadId = o.thread_id || o.threadId;
        this.turns.alias(entry, "codex", realThreadId);
        return;
      }
      const it = o.item;
      if ((o.type === "item.updated" || o.type === "item.completed" || o.type === "item.started") && it) {
        const streaming = o.type !== "item.completed";
        const id = it.id || `codex:${seq}`;
        if (it.item_type === "agent_message" || it.type === "agent_message") {
          if (it.text) emit(assistantMessage(base(id), it.text, streaming));
        } else if (it.item_type === "reasoning" || it.type === "reasoning") {
          if (it.text) emit(thinking(base(id), it.text));
        } else if (it.item_type === "command_execution" || it.type === "command_execution") {
          emit(toolCall(base(id), { name: "shell", input: { command: it.command || "" }, status: streaming ? "running" : "success" }));
          if (!streaming && it.aggregated_output) {
            emit(toolResult(base(`${id}:o`), { toolCallId: id, content: { kind: "text", text: it.aggregated_output }, isError: it.exit_code ? it.exit_code !== 0 : false }));
          }
        } else if (it.item_type === "file_change" || it.type === "file_change") {
          const patch = (it.changes || []).map((c) => c.diff || "").join("\n");
          if (patch) emit(toolResult(base(`${id}:d`), { toolCallId: id, content: { kind: "diff", path: it.changes?.[0]?.path || "", patch }, isError: false }));
        }
        return;
      }
      if (o.type === "turn.failed" || o.type === "error") {
        emit(systemEvent(base(`codex:err:${seq}`), String(o.error?.message || o.message || "turn failed"), "error"));
        finish();
        return;
      }
      if (o.type === "turn.completed") finish();
    };

    // Idle timeout (reset on any output) — absolute limits kill long tool runs.
    let timer;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, TURN_TIMEOUT_MS);
    };
    arm();
    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => { arm(); if (line) { try { handle(JSON.parse(line)); } catch {} } });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && !settled) {
        emit(systemEvent(base(`codex:err`), `codex exited (${code}): ${stderrTail.trim().slice(-500)}`, "error"));
      }
      finish();
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      emit(systemEvent(base(`codex:err`), `codex failed to start: ${e?.message || e}`, "error"));
      finish();
    });

    return { stop: () => { try { child.kill("SIGINT"); } catch {} setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 5000).unref?.(); }, done };
  }
}

/** Shape a codex function/tool call like the daemon did (shell → {command}). */
function codexCall(p) {
  const name = p.name || p.tool || "tool";
  let input = {};
  try { input = typeof p.arguments === "string" ? JSON.parse(p.arguments) : p.arguments || {}; } catch { input = { arguments: p.arguments }; }
  if ((name === "shell" || name === "exec_command" || name === "container.exec") && input) {
    const cmd = Array.isArray(input.command) ? input.command.join(" ") : input.command || input.cmd || "";
    return { name: "shell", input: { command: String(cmd) }, status: "success" };
  }
  return { name, input, status: "success" };
}

/** function_call_output.output is often a JSON envelope {output, metadata}. */
function codexOutput(raw) {
  if (typeof raw !== "string") return raw == null ? "" : JSON.stringify(raw);
  try {
    const o = JSON.parse(raw);
    if (o && typeof o.output === "string") return o.output;
  } catch {}
  return raw;
}

function failedTurn(threadId, message, onEvent) {
  try {
    onEvent({
      id: `${threadId || "codex"}:spawn-err`, conversationId: threadId || null, seq: 1,
      ts: new Date().toISOString(), type: "system_event", message, level: "error",
    });
  } catch {}
  return { stop: () => {}, done: Promise.resolve(threadId || null) };
}
