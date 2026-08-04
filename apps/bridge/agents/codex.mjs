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
import { stripNoise } from "@pounce/transcript";
import { SessionIndex } from "./session-index.mjs";
import {
  userMessage,
  thinking,
  assistantMessage,
  toolCall,
  toolResult,
  systemEvent,
  readTailLines,
} from "./events.mjs";
import { agentEnv, binVersion, binPath, liveAgentCwds } from "./env.mjs";
import { noUsage, usageResult } from "./usage.mjs";

const ROOT = path.join(os.homedir(), ".codex", "sessions");
const INDEX_FILE = path.join(os.homedir(), ".codex", "session_index.jsonl");
// Codex refreshes this from the server; it is the account's real model list.
const MODELS_FILE = path.join(os.homedir(), ".codex", "models_cache.json");
const CONFIG_FILE = path.join(os.homedir(), ".codex", "config.toml");
const RUNNING_WINDOW_MS = 120_000;
// With a live codex process confirmed in the thread's cwd, a quiet mid-turn
// transcript stays "running" this long (covers long tool calls/builds).
const LIVE_EXTENDED_WINDOW_MS = 2 * 60 * 60_000;
const TURN_TIMEOUT_MS = Number(process.env.BRIDGE_TURN_TIMEOUT_MS || 300_000);
const FILE_RE = /^rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-([0-9a-f-]{36})\.jsonl$/;

export class CodexAdapter {
  constructor({ turns }) {
    this.id = "codex";
    this.displayName = "Codex";
    this.description = "OpenAI's Codex CLI";
    this.capabilities = {
      streaming: true,
      tools: true,
      images: false,
      thinking: true,
      terminal: true,
      git: true,
    };
    this.turns = turns;
    this._titles = null; // id -> thread_name, lazily loaded from session_index.jsonl
    this.index = new SessionIndex({
      root: ROOT,
      match: (name) => FILE_RE.test(name),
      scanFile: (file, st) => this._scanRollout(file, st),
      cacheName: "codex",
    });
  }

  onDirty(cb) {
    this.index.onDirty(cb);
  }

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
      let createdAt = null,
        cwd = null,
        preview = null;
      let lines = 0;
      const stream = createReadStream(file, "utf8");
      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      const settle = () => {
        rl.close();
        stream.destroy();
        resolve({
          id,
          filePath: file,
          cwd,
          name: null,
          preview,
          createdAt: createdAt || new Date(st.birthtimeMs || st.mtimeMs).toISOString(),
          updatedAt: new Date(st.mtimeMs).toISOString(),
          gitBranch: null,
          sizeBytes: st.size,
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

  /**
   * Token totals and plan consumption — never dollars.
   *
   * Codex bills against a ChatGPT plan, not per-request USD, and reports no
   * cost field anywhere in its rollouts. What it does give is official and
   * useful in its own right: `token_count.info.total_token_usage` (CUMULATIVE,
   * so the last such event is the thread total, not a sum), the rate-limit
   * windows it's consuming, and the model's context window. We surface those
   * rather than pricing its tokens ourselves.
   */
  async getUsage(threadId) {
    const file = await this.findFile(threadId);
    if (!file) return noUsage("no-transcript");
    let rl;
    try {
      rl = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
    } catch {
      return noUsage("no-transcript");
    }
    let usage = null,
      lastUsage = null,
      rateLimits = null,
      contextWindow = null,
      turns = 0;
    const models = new Set();
    for await (const line of rl) {
      if (!line) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      const p = o.payload;
      if (!p) continue;
      if (o.type === "turn_context") {
        if (p.model) models.add(p.model);
        continue;
      }
      if (o.type !== "event_msg") continue;
      if (p.type === "task_complete") turns++;
      if (p.type !== "token_count") continue;
      // Later events supersede earlier ones — totals are cumulative, and the
      // rate-limit snapshot is only meaningful as of the most recent report.
      if (p.info?.total_token_usage) usage = p.info.total_token_usage;
      // `last_token_usage` is that one request rather than the running total —
      // its input_tokens (cached included) is what currently fills the window.
      if (p.info?.last_token_usage) lastUsage = p.info.last_token_usage;
      if (p.info?.model_context_window) contextWindow = p.info.model_context_window;
      if (p.rate_limits) rateLimits = p.rate_limits;
    }
    if (!usage) return noUsage("no-usage");
    const primary = rateLimits?.primary || null;
    return usageResult({
      tokens: {
        // Codex counts cached input separately from `input_tokens`; keep them
        // in the cacheRead slot so the total doesn't double-count.
        input: Math.max(0, (usage.input_tokens || 0) - (usage.cached_input_tokens || 0)),
        output: usage.output_tokens || 0,
        cacheRead: usage.cached_input_tokens || 0,
        reasoning: usage.reasoning_output_tokens || 0,
      },
      cost: null, // plan-based: no USD exists to report
      model: [...models].pop() || null,
      models: [...models],
      messages: turns,
      contextWindow,
      contextUsed: lastUsage?.input_tokens ?? null,
      rateLimit: primary
        ? {
            usedPercent: primary.used_percent ?? null,
            windowMinutes: primary.window_minutes ?? null,
            resetsAt: primary.resets_at ?? null,
            planType: rateLimits?.plan_type ?? null,
          }
        : null,
    });
  }

  async getEvents(threadId, { limit } = {}) {
    const file = await this.findFile(threadId);
    if (!file) return [];
    const turns = [];
    let cur = null;
    const add = (ev, startsTurn = false) => {
      if (startsTurn || !cur) {
        cur = [];
        turns.push(cur);
      }
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
    // apply_patch call id -> unified diff, consumed by the paired output.
    const patches = new Map();
    const uniq = (id) => {
      const n = idCount.get(id) || 0;
      idCount.set(id, n + 1);
      return n === 0 ? id : `${id}#${n}`;
    };

    let rl;
    try {
      rl = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
    } catch {
      return [];
    }
    for await (const line of rl) {
      if (!line) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
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
          // `summary` is only populated when reasoning summaries are enabled;
          // otherwise the text sits in `content[]` (and, when the model encrypts
          // it, only in `encrypted_content`, which we cannot render). Reading
          // `summary` alone dropped 861/861 reasoning items on a real transcript.
          const text = [...(p.summary || []), ...(Array.isArray(p.content) ? p.content : [])]
            .map((s) => (typeof s === "string" ? s : s?.text || ""))
            .join("\n")
            .trim();
          if (text) add(thinking(base(uniq(p.id || `r:${ts}`)), text));
        } else if (p.type === "function_call" || p.type === "custom_tool_call") {
          const callId = p.call_id || p.id || `c:${ts}`;
          const call = codexCall(p);
          // Remember the patch so the paired output can render as a diff.
          if (call.name === "apply_patch") {
            const patch = patchFromApplyPatch(call.input?.patch);
            if (patch) patches.set(callId, patch);
          }
          add(toolCall(base(callId), call));
        } else if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
          const callId = p.call_id || `c:${ts}`;
          const patch = patches.get(callId);
          add(
            toolResult(base(`${callId}:o`), {
              toolCallId: callId,
              content: patch
                ? { kind: "diff", path: firstPatchPath(patch), patch }
                : { kind: "text", text: codexOutput(p.output) },
              isError: false,
            }),
          );
          patches.delete(callId);
        } else if (p.type === "web_search_call") {
          // Otherwise dropped entirely — 27 searches vanished from one transcript.
          const q = p.action?.query || (p.action?.queries || []).join("\n") || "";
          const callId = p.call_id || p.id || `ws:${ts}`;
          add(toolCall(base(callId), { name: "web_search", input: { query: q } }));
        }
        continue;
      }
      if (o.type === "event_msg" && p.type === "turn_aborted") {
        add(systemEvent(base(`ab:${ts}`), "Turn interrupted", "warning"));
      }
      // Compaction silently removed history mid-thread; without a marker the
      // transcript just appears to jump.
      if (o.type === "event_msg" && p.type === "context_compacted") {
        add(systemEvent(base(`cx:${ts}`), "Context compacted", "info"));
      }
      if (o.type === "event_msg" && p.type === "thread_rolled_back") {
        add(systemEvent(base(`rb:${ts}`), "Thread rolled back", "warning"));
      }
    }

    const events = turns.flat();
    events.forEach((ev, i) => {
      ev.seq = i + 1;
    });
    return events;
  }

  async getActivity(threadId) {
    if (this.turns.isRunning("codex", threadId)) {
      return { activity: "running", lastActivityAt: new Date().toISOString() };
    }
    const cwd = this.index.metas.get(threadId)?.cwd;
    const [file, live] = await Promise.all([this.findFile(threadId), cwd ? liveAgentCwds() : null]);
    if (!file) return { activity: "idle", lastActivityAt: null };
    let mtimeMs;
    try {
      mtimeMs = statSync(file).mtimeMs;
    } catch {
      return { activity: "idle", lastActivityAt: null };
    }
    const lastActivityAt = new Date(mtimeMs).toISOString();
    // Same liveness refinement as the claude adapter: a live codex process in
    // the thread's cwd keeps a quiet mid-turn "running"; its absence demotes
    // immediately; unknown falls back to the mtime window.
    const liveInCwd = cwd && live ? (live.get("codex")?.has(cwd) ?? false) : null;
    const recent =
      liveInCwd !== false &&
      Date.now() - mtimeMs < (liveInCwd ? LIVE_EXTENDED_WINDOW_MS : RUNNING_WINDOW_MS);
    // Last task marker wins: started-without-complete while fresh → running.
    for (const line of readTailLines(file).reverse()) {
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o.type !== "event_msg") continue;
      const t = o.payload?.type;
      if (t === "task_complete") return { activity: "completed", lastActivityAt };
      if (t === "turn_aborted") return { activity: "completed", lastActivityAt };
      if (t === "task_started")
        return { activity: recent ? "running" : "completed", lastActivityAt };
    }
    return { activity: "completed", lastActivityAt };
  }

  /**
   * Models come from Codex's OWN cache (~/.codex/models_cache.json), which the
   * CLI refreshes from the server — i.e. the account's real, current list.
   *
   * This was previously a hardcoded pair, and a hardcoded list goes stale
   * silently: it offered `gpt-5.2-codex` / `gpt-5.1-codex-mini` long after both
   * had gone, and the account rejected them with
   * "model is not supported when using Codex with a ChatGPT account" (HTTP 400).
   * The CLI has no `models` subcommand to ask instead, so read what it stores.
   *
   * The default is whatever config.toml actually selects, never a guess.
   */
  listModels() {
    const configured = configuredModel();
    const models = readModelsCache();
    if (!models.length) {
      // No cache yet (fresh install, or never online). Offer only what config
      // selects rather than inventing ids the account may reject.
      return configured
        ? [
            {
              id: configured,
              name: configured,
              description: null,
              isDefault: true,
              deprecated: false,
            },
          ]
        : [];
    }
    // A configured model missing from the cache is exactly the broken state
    // above — don't mark it default; fall back to the highest-priority entry.
    const def = models.some((m) => m.slug === configured) ? configured : models[0].slug;
    return models.map((m) => ({
      id: m.slug,
      name: m.display_name || m.slug,
      description: m.description || null,
      isDefault: m.slug === def,
      deprecated: false,
    }));
  }

  /**
   * `codex exec --json [resume <id>]` — emits JSONL: thread.started,
   * item.started/updated/completed (agent_message / reasoning /
   * command_execution / file_change / error), turn.started, turn.completed /
   * turn.failed.
   *
   * VERIFIED against codex-cli 0.146 (live capture, incl. a resumed turn).
   * Two behaviours the docs do not spell out, both of which broke rendering:
   *   - `item.id` is `item_0, item_1, …` and RESTARTS every turn, so ids must
   *     be namespaced per turn before they reach the app.
   *   - `file_change.changes[]` is only `{path, kind}` — no diff text is ever
   *     supplied, so there is no patch to render from the stream alone.
   * Keep parsing defensive; history refetch backstops any remaining gaps.
   */
  startTurn({ threadId, text, cwd, permissionMode, model }, onEvent) {
    this.turns.assertCapacity();
    const resume = threadId && /^[0-9a-f-]{36}$/i.test(threadId);
    const args = ["exec", "--json"];
    if (resume) args.push("resume", threadId);
    if (cwd && existsSync(cwd)) args.push("-C", cwd);
    if (model) args.push("-m", model);
    args.push(
      permissionMode === "bypassPermissions"
        ? "--dangerously-bypass-approvals-and-sandbox"
        : "--full-auto",
    );
    args.push(text);

    let child;
    try {
      child = spawn(binPath("codex"), args, {
        cwd: cwd && existsSync(cwd) ? cwd : os.homedir(),
        env: agentEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (e) {
      return failedTurn(threadId, `codex failed to start: ${e?.message || e}`, onEvent);
    }
    const entry = this.turns.register("codex", [threadId || "codex:pending"], child);

    let seq = 0;
    // Codex numbers items `item_0, item_1, …` and RESTARTS at item_0 on every
    // resumed turn (verified against codex-cli 0.146). Emitting those ids raw
    // made turn 2's item_1 collide with turn 1's, so the app either rejected the
    // insert or overwrote the earlier message. Namespace them per turn — the
    // history parser already guards the same hazard with uniq().
    const turnKey = `ct${Date.now().toString(36)}`;
    let realThreadId = threadId || null;
    const now = () => new Date().toISOString();
    const base = (id) => ({ id, conversationId: realThreadId, seq: ++seq, ts: now() });
    const emit = (ev) => {
      try {
        onEvent(ev);
      } catch {}
    };
    emit(userMessage(base(`codex:input:${Date.now()}`), text));

    let resolveDone;
    const done = new Promise((res) => {
      resolveDone = res;
    });
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      this.turns.release(entry);
      resolveDone(realThreadId || threadId || null);
    };

    let stderrTail = "";
    child.stderr.on("data", (d) => {
      stderrTail = (stderrTail + d).slice(-8192);
    });

    const handle = (o) => {
      if (o.type === "thread.started" && (o.thread_id || o.threadId)) {
        realThreadId = o.thread_id || o.threadId;
        this.turns.alias(entry, "codex", realThreadId);
        return;
      }
      const it = o.item;
      if (
        (o.type === "item.updated" || o.type === "item.completed" || o.type === "item.started") &&
        it
      ) {
        const streaming = o.type !== "item.completed";
        const id = `${turnKey}:${it.id || seq}`;
        const kind = it.item_type || it.type;
        if (kind === "error") {
          // Codex reports config/model problems as completed items, not as the
          // top-level `error` event this handler used to check exclusively.
          emit(systemEvent(base(`${id}:e`), String(it.message || "codex error"), "warning"));
          return;
        }
        if (it.item_type === "agent_message" || it.type === "agent_message") {
          if (it.text) emit(assistantMessage(base(id), it.text, streaming));
        } else if (it.item_type === "reasoning" || it.type === "reasoning") {
          if (it.text) emit(thinking(base(id), it.text));
        } else if (it.item_type === "command_execution" || it.type === "command_execution") {
          emit(
            toolCall(base(id), {
              name: "shell",
              input: { command: it.command || "" },
              status: streaming ? "running" : "success",
            }),
          );
          // item.updated carries the output aggregated SO FAR — forward it under
          // a stable id so the app updates the running card's output in place
          // (live terminal tail), instead of waiting for completion.
          if (it.aggregated_output) {
            emit(
              toolResult(base(`${id}:o`), {
                toolCallId: id,
                content: { kind: "text", text: it.aggregated_output },
                isError: !streaming && it.exit_code ? it.exit_code !== 0 : false,
              }),
            );
          }
        } else if (it.item_type === "file_change" || it.type === "file_change") {
          // Real `changes[]` entries are only `{path, kind}` — codex-cli 0.146
          // ships NO diff text here. The old code joined `c.diff` into an empty
          // string and then skipped on `if (patch)`, so edits were invisible.
          // Emit the card regardless, and use a diff body only if one exists.
          const changes = it.changes || [];
          emit(
            toolCall(base(id), {
              name: "edit",
              input: { paths: changes.map((c) => c.path).filter(Boolean) },
              status: streaming ? "running" : "success",
            }),
          );
          const patch = changes
            .map((c) => c.diff || "")
            .join("\n")
            .trim();
          const summary = changes.map((c) => `${c.kind || "update"}: ${c.path || ""}`).join("\n");
          if (patch || summary)
            emit(
              toolResult(base(`${id}:d`), {
                toolCallId: id,
                content: patch
                  ? { kind: "diff", path: changes[0]?.path || "", patch }
                  : { kind: "text", text: summary },
                isError: false,
              }),
            );
        }
        return;
      }
      if (o.type === "turn.failed" || o.type === "error") {
        emit(
          systemEvent(
            base(`codex:err:${seq}`),
            String(o.error?.message || o.message || "turn failed"),
            "error",
          ),
        );
        finish();
        return;
      }
      if (o.type === "turn.completed") finish();
    };

    // Idle timeout (reset on any output) — absolute limits kill long tool runs.
    let timer;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
      }, TURN_TIMEOUT_MS);
    };
    arm();
    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      arm();
      if (line) {
        try {
          handle(JSON.parse(line));
        } catch {}
      }
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && !settled) {
        emit(
          systemEvent(
            base(`codex:err`),
            `codex exited (${code}): ${stderrTail.trim().slice(-500)}`,
            "error",
          ),
        );
      }
      finish();
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      emit(systemEvent(base(`codex:err`), `codex failed to start: ${e?.message || e}`, "error"));
      finish();
    });

    return {
      stop: () => {
        try {
          child.kill("SIGINT");
        } catch {}
        setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {}
        }, 5000).unref?.();
      },
      done,
    };
  }
}

/**
 * Selectable models from Codex's cache, best-priority first. `visibility:
 * "hide"` marks internal entries (e.g. `codex-auto-review`) that are not
 * user-choosable, so they never reach the picker.
 */
function readModelsCache() {
  try {
    const raw = JSON.parse(readFileSync(MODELS_FILE, "utf8"));
    const list = Array.isArray(raw?.models) ? raw.models : [];
    return list
      .filter((m) => m?.slug && m.visibility !== "hide")
      .sort(
        (a, b) => (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER),
      );
  } catch {
    return [];
  }
}

/**
 * Top-level `model = "…"` from ~/.codex/config.toml. Stops at the first table
 * header: `[projects."…"]` and friends carry their own keys, and a per-project
 * `model` is not the global default.
 */
function configuredModel() {
  try {
    for (const line of readFileSync(CONFIG_FILE, "utf8").split("\n")) {
      const s = line.trim();
      if (s.startsWith("[")) break;
      const m = /^model\s*=\s*["']([^"']+)["']/.exec(s);
      if (m) return m[1];
    }
  } catch {}
  return null;
}

/** Tool names whose payload is a shell command — rendered as a terminal card. */
const SHELL_TOOLS = new Set(["shell", "exec", "exec_command", "local_shell", "container.exec"]);

/**
 * Shape a codex function/tool call like the daemon did (shell → {command}).
 *
 * Two wire shapes, and only one was handled before: `function_call` carries a
 * JSON string in `arguments`, while `custom_tool_call` (apply_patch, exec)
 * carries a FREEFORM string in `input`. Reading only `arguments` left every
 * custom tool with an empty input — measured at 96/151 tool cards blank on a
 * real host, including 95/95 `exec` calls.
 */
function codexCall(p) {
  const name = p.name || p.tool || "tool";
  const raw = p.arguments ?? p.input;

  // apply_patch's payload is the patch envelope itself, never JSON.
  if (name === "apply_patch") {
    return { name, input: { patch: typeof raw === "string" ? raw : "" }, status: "success" };
  }

  let input;
  if (typeof raw === "string") {
    try {
      input = JSON.parse(raw);
    } catch {
      // Freeform custom-tool payload — keep the text rather than dropping it.
      input = SHELL_TOOLS.has(name) ? { command: raw } : { text: raw };
    }
  } else {
    input = raw || {};
  }
  if (input && typeof input === "object" && SHELL_TOOLS.has(name)) {
    const cmd = Array.isArray(input.command)
      ? input.command.join(" ")
      : input.command || input.cmd || input.script || input.text || "";
    return { name: "shell", input: { command: String(cmd) }, status: "success" };
  }
  return { name, input, status: "success" };
}

/**
 * Tool output arrives in three shapes: a bare string, a `{output, metadata}`
 * envelope, or a JSON array of `{type:"input_text", text}` content parts (what
 * `exec` returns). Only the first two were unwrapped, so array results rendered
 * as a raw JSON blob complete with `input_text` keys.
 */
function codexOutput(raw) {
  if (typeof raw !== "string") return raw == null ? "" : partsText(raw);
  try {
    const o = JSON.parse(raw);
    if (o && typeof o.output === "string") return o.output;
    if (Array.isArray(o)) return partsText(o);
  } catch {}
  return raw;
}

/** First file path in a synthetic unified diff, for the result header. */
function firstPatchPath(patch) {
  const m = /^diff --git a\/(.*) b\/(.*)$/m.exec(patch || "");
  return m?.[2] || m?.[1] || "";
}

/** Join an array of content parts (or stringify anything else). */
function partsText(v) {
  if (Array.isArray(v)) {
    const text = v
      .map((c) => (typeof c === "string" ? c : typeof c?.text === "string" ? c.text : ""))
      .join("");
    if (text.trim()) return text;
  }
  return JSON.stringify(v);
}

/**
 * Convert codex's `apply_patch` envelope into a unified diff the app can render.
 *
 * Codex emits `*** Begin Patch / *** Update File: <path> / +-lines / *** End
 * Patch`, which is not a unified diff — splitPatch() keys on `diff --git`, so
 * without synthetic headers the whole patch collapses into one unnamed file.
 * Returns "" when nothing file-shaped is found.
 */
function patchFromApplyPatch(src) {
  if (typeof src !== "string" || !src.includes("*** ")) return "";
  const out = [];
  let inFile = false;
  for (const line of src.split("\n")) {
    const m = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (m) {
      const path = m[2].trim();
      out.push(`diff --git a/${path} b/${path}`);
      inFile = true;
      continue;
    }
    // Other directives (Begin/End Patch, Move to:) carry no hunk content.
    if (line.startsWith("*** ")) continue;
    if (inFile) out.push(line);
  }
  return out.length ? out.join("\n") : "";
}

function failedTurn(threadId, message, onEvent) {
  try {
    onEvent({
      id: `${threadId || "codex"}:spawn-err`,
      conversationId: threadId || null,
      seq: 1,
      ts: new Date().toISOString(),
      type: "system_event",
      message,
      level: "error",
    });
  } catch {}
  return { stop: () => {}, done: Promise.resolve(threadId || null) };
}
