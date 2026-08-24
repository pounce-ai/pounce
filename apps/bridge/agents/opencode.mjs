/**
 * OpenCode adapter — reads sessions from opencode's own store and drives turns
 * via `opencode run --format json`.
 *
 * Current opencode persists to ~/.local/share/opencode/opencode.db (sqlite,
 * WAL). Two schemas coexist in that file:
 *   - v2 (opencode ≥1.18): session_v2(id, directory, title, parent_id,
 *     time_created, time_updated, …) + session_message(id, session_id, type,
 *     seq, data JSON). type is one of user|assistant|synthetic|compaction|
 *     system|model-switched — only user/assistant are transcript; the rest are
 *     opencode plumbing. Assistant data carries the parts inline as
 *     content[{type: text|reasoning|tool, name, id, state{status, input,
 *     metadata, content[{type:text,text}] | error{message}}}]; user data is
 *     {text, time}. New sessions exist ONLY here.
 *   - legacy: session(id, …) + message(id, session_id, data JSON{role,
 *     time}) + part(id, message_id, session_id, data JSON{type: text|
 *     reasoning|tool|step-*}). Some sessions are dual-written; prefer v2.
 * Read-only via node:sqlite — safe alongside a writing opencode (WAL).
 * Older installs used a JSON file tree (storage/session/<project>/ses_*.json +
 * storage/message/<ses>/msg_*.json + storage/part/<msg>/prt_*.json); we fall
 * back to that when the db is absent or node:sqlite isn't available (e.g. an
 * older Bun runtime).
 */
import { createReadStream, existsSync, readFileSync, readdirSync, statSync, watch } from "node:fs";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  userMessage,
  thinking,
  assistantMessage,
  toolCall,
  toolResult,
  systemEvent,
} from "./events.mjs";
import { agentEnv, binVersion, binPath } from "./env.mjs";
import { noUsage, usageResult } from "./meter.mjs";
import { openSqliteReadOnly } from "./sqlite.mjs";

const DATA_DIR = path.join(os.homedir(), ".local", "share", "opencode");
const DB_FILE = path.join(DATA_DIR, "opencode.db");
const STORE_DIR = path.join(DATA_DIR, "storage");
const RUNNING_WINDOW_MS = 120_000;
const TURN_TIMEOUT_MS = Number(process.env.BRIDGE_TURN_TIMEOUT_MS || 300_000);

export class OpencodeAdapter {
  constructor({ turns }) {
    this.id = "opencode";
    this.displayName = "OpenCode";
    this.description = "SST's OpenCode CLI";
    this.capabilities = {
      streaming: true,
      tools: true,
      images: false,
      thinking: false,
      terminal: true,
      git: true,
    };
    this.turns = turns;
    this._db = undefined; // undefined = not tried, null = unavailable
    this._v2 = undefined; // undefined = not probed
    this._dirty = new Set();
    this._watcher = null;
    this._watchTimer = null;
  }

  /** Does the db carry the v2 schema (opencode ≥1.18)? Re-probed after writes
   *  so a mid-run migration is picked up. */
  _hasV2(db) {
    if (this._v2 !== undefined) return this._v2;
    try {
      this._v2 = !!db
        .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_v2'`)
        .get();
    } catch {
      this._v2 = false;
    }
    return this._v2;
  }

  onDirty(cb) {
    this._dirty.add(cb);
  }

  async isAvailable() {
    return (await binVersion("opencode")) != null;
  }

  /** Open the sqlite store read-only once; null when impossible. Also attach a
   *  WAL watcher so cached histories drop when opencode writes. */
  async db() {
    if (this._db !== undefined) return this._db;
    this._db = null;
    try {
      if (existsSync(DB_FILE)) {
        // Runtime-agnostic: the shipped app runs on Bun, which has no
        // node:sqlite — reaching for it directly sent every desktop user down
        // the legacy-file fallback below and showed a fraction of their history.
        this._db = await openSqliteReadOnly(DB_FILE);
        if (this._db) this._watchDb();
      }
    } catch {
      this._db = null; // no sqlite at all — file-store fallback below
    }
    return this._db;
  }

  _watchDb() {
    if (this._watcher) return;
    try {
      // sqlite WAL: every write touches opencode.db-wal. We can't tell which
      // session changed, so (debounced) drop all opencode history entries.
      this._watcher = watch(DATA_DIR, (_e, f) => {
        if (!f || !f.startsWith("opencode.db")) return;
        clearTimeout(this._watchTimer);
        this._watchTimer = setTimeout(() => {
          this._v2 = undefined; // a write may have migrated the schema
          for (const cb of this._dirty) {
            try {
              cb("");
            } catch {}
          }
        }, 1000);
      });
    } catch {}
  }

  async listThreads() {
    const db = await this.db();
    if (db) {
      // v2 is authoritative for opencode ≥1.18 (new sessions exist only
      // there); merge legacy rows for sessions that predate the v2 schema.
      // Each query gets its own try: a v2-only install has no legacy table,
      // and a throw must not discard the v2 rows already collected.
      const seen = new Set();
      const rows = [];
      if (this._hasV2(db)) {
        try {
          for (const r of db
            .prepare(
              `SELECT id, directory, title, time_created, time_updated
                 FROM session_v2 WHERE parent_id IS NULL AND time_archived IS NULL
                 ORDER BY time_updated DESC LIMIT 1000`,
            )
            .all()) {
            seen.add(r.id);
            rows.push(r);
          }
        } catch {}
      }
      try {
        for (const r of db
          .prepare(
            `SELECT id, directory, title, time_created, time_updated
               FROM session WHERE parent_id IS NULL AND time_archived IS NULL
               ORDER BY time_updated DESC LIMIT 1000`,
          )
          .all()) {
          if (!seen.has(r.id)) rows.push(r);
        }
      } catch {}
      if (rows.length) {
        rows.sort((a, b) => (b.time_updated || 0) - (a.time_updated || 0));
        return rows.slice(0, 1000).map((r) => ({
          id: r.id,
          filePath: null,
          cwd: r.directory || null,
          name: r.title || null,
          preview: r.title || null,
          createdAt: msIso(r.time_created),
          updatedAt: msIso(r.time_updated),
          gitBranch: null,
          sizeBytes: 0,
        }));
      }
    }
    return this._listThreadsFiles();
  }

  /**
   * The one adapter with fully official USD: opencode computes and stores
   * `cost` on every assistant message alongside its token breakdown, for the
   * whole thread — no live capture needed, and nothing for us to price. Works
   * over either backing store since both yield the same message `data`.
   */
  async getUsage(threadId) {
    const db = await this.db();
    const messages = db ? this._messagesDb(db, threadId) : this._messagesFiles(threadId);
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, reasoning: 0 };
    const models = new Set();
    let cost = 0,
      costRows = 0,
      count = 0,
      contextUsed = null;
    for (const { data } of messages) {
      if (!data || data.role !== "assistant") continue;
      const t = data.tokens;
      if (!t) continue;
      count++;
      // opencode's per-message `total` is that request's whole footprint, so
      // the newest one is the current fill. Older records predate that field —
      // sum the same parts it covers rather than losing the reading. opencode
      // stores no context window, so this is a raw number with nothing to take
      // a percentage against.
      contextUsed =
        typeof t.total === "number"
          ? t.total
          : (t.input || 0) + (t.output || 0) + (t.cache?.read || 0) + (t.cache?.write || 0);
      tokens.input += t.input || 0;
      tokens.output += t.output || 0;
      tokens.reasoning += t.reasoning || 0;
      tokens.cacheRead += t.cache?.read || 0;
      tokens.cacheCreation += t.cache?.write || 0;
      if (typeof data.cost === "number" && Number.isFinite(data.cost)) {
        cost += data.cost;
        costRows++;
      }
      if (data.modelID) models.add(data.modelID);
    }
    if (!count) return noUsage("no-usage");
    return usageResult({
      tokens,
      cost: costRows ? cost : null,
      costComplete: costRows === count,
      costSource: costRows ? "agent" : null,
      model: [...models].pop() || null,
      models: [...models],
      messages: count,
      contextUsed,
    });
  }

  async getEvents(threadId, { limit } = {}) {
    const db = await this.db();
    const messages = db ? this._messagesDb(db, threadId) : this._messagesFiles(threadId);
    if (!messages.length) return [];

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

    for (const { id: msgId, data, parts } of messages) {
      const role = data.role;
      const ts = msIso(data.time?.created) || new Date().toISOString();
      for (const part of parts) {
        const base = { id: part.id, conversationId: threadId, seq: 0, ts };
        const d = part.data;
        if (d.type === "text" && d.text?.trim()) {
          if (role === "user") add(userMessage(base, unwrapRunPrompt(d.text)), true);
          else add(assistantMessage(base, d.text));
        } else if (d.type === "reasoning" && d.text?.trim()) {
          add(thinking(base, d.text));
        } else if (d.type === "tool") {
          const callId = d.callID || part.id;
          const st = d.state || {};
          // File-editing tools carry the real unified diff in state.metadata.diff.
          // Without this the card showed the raw {oldString,newString} blob as
          // input and "Edit applied successfully." as output — measured 1,896
          // discarded diffs (1,634 edit + 262 apply_patch) on a real store.
          const patch = unifiedFromOpencode(st.metadata?.diff, st.input?.filePath);
          add(
            toolCall(
              { ...base, id: callId },
              {
                name: d.tool === "bash" ? "shell" : d.tool || "tool",
                input:
                  d.tool === "bash"
                    ? { command: st.input?.command || "" }
                    : // The diff below says what changed; repeating both sides of
                      // the edit in the input just buries the card.
                      patch
                      ? { filePath: st.input?.filePath || "" }
                      : (st.input ?? {}),
                status: st.status === "error" ? "error" : "success",
              },
            ),
          );
          if (patch) {
            add(
              toolResult(
                { ...base, id: `${callId}:o` },
                {
                  toolCallId: callId,
                  content: { kind: "diff", path: st.input?.filePath || "", patch },
                  isError: st.status === "error",
                },
              ),
            );
          } else if (st.output) {
            add(
              toolResult(
                { ...base, id: `${callId}:o` },
                {
                  toolCallId: callId,
                  content: { kind: "text", text: String(st.output).slice(0, 200_000) },
                  isError: st.status === "error",
                },
              ),
            );
          }
        } else if (d.type === "compaction") {
          // Otherwise the transcript silently jumps where history was dropped.
          add(systemEvent(base, "Context compacted", "info"));
        }
        // step-start / step-finish / snapshot / patch parts: plumbing, skipped.
        // (`patch` is only {hash, files[]} — a snapshot marker with no diff text.)
      }
      // The failure hangs off the MESSAGE, not any part, so it has to be read
      // here or the refetch quietly drops what the live stream just showed —
      // the error would flash during the turn and vanish a second later.
      const failure = role === "assistant" ? errorText(data.error) : null;
      if (failure) {
        add(
          systemEvent(
            { id: `${msgId || "opencode"}:err`, conversationId: threadId, seq: 0, ts },
            failure,
            "error",
          ),
        );
      }
    }

    const events = turns.flat();
    events.forEach((ev, i) => {
      ev.seq = i + 1;
    });
    return events;
  }

  _messagesDb(db, threadId) {
    // v2 (opencode ≥1.18): parts ride inline in session_message.data.content.
    // Map them to the legacy part shape so getEvents() works unchanged.
    if (this._hasV2(db)) {
      let rows;
      try {
        // session_message.type has six values; synthetic/compaction/system/
        // model-switched are opencode plumbing (synthetic duplicates tool
        // output, system carries injected instructions) — the legacy schema
        // only ever had user/assistant, so keep the transcript to those.
        rows = db
          .prepare(
            `SELECT id, type, data FROM session_message
               WHERE session_id = ? AND type IN ('user', 'assistant')
               ORDER BY seq, id`,
          )
          .all(threadId);
      } catch {
        rows = null;
      }
      if (rows?.length) {
        // Map per-row: one malformed row must not abort the whole thread into
        // a legacy fallback that has nothing for a v2-only session.
        return rows.map((r) => {
          try {
            const d = JSON.parse(r.data);
            const content = Array.isArray(d.content)
              ? d.content
              : typeof d.text === "string"
                ? [{ type: "text", text: d.text }]
                : [];
            const parts = [];
            content.forEach((c, i) => {
              // v2 part ids are per-turn counters ("read_0") — namespace by
              // message id so event ids stay unique across the conversation.
              const id = `${r.id}:${c.id || i}`;
              if (c.type === "text") parts.push({ id, data: { type: "text", text: c.text } });
              else if (c.type === "reasoning")
                parts.push({ id, data: { type: "reasoning", text: c.text } });
              else if (c.type === "tool") {
                const st = c.state || {};
                parts.push({
                  id,
                  data: {
                    type: "tool",
                    tool: c.name || null,
                    callID: id,
                    // Spread st: getEvents reads metadata.diff (file-edit
                    // diffs) and status off the state. output is derived —
                    // errored tools carry their message in error.message
                    // because content/output are null on failure.
                    state: { ...st, output: v2ToolOutput(st) },
                  },
                });
              }
            });
            return { id: r.id, data: { role: r.type, time: d.time, error: d.error }, parts };
          } catch {
            return { id: r.id, data: { role: r.type, time: null }, parts: [] };
          }
        });
      }
      // v2 tables exist but this session predates them — fall through to legacy.
    }
    try {
      const msgs = db
        .prepare(`SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, id`)
        .all(threadId);
      const parts = db
        .prepare(
          `SELECT id, message_id, data FROM part WHERE session_id = ? ORDER BY time_created, id`,
        )
        .all(threadId);
      const bucket = new Map();
      for (const p of parts) {
        let data;
        try {
          data = JSON.parse(p.data);
        } catch {
          continue;
        }
        const arr = bucket.get(p.message_id) || bucket.set(p.message_id, []).get(p.message_id);
        arr.push({ id: p.id, data });
      }
      return msgs.map((m) => {
        let data;
        try {
          data = JSON.parse(m.data);
        } catch {
          data = {};
        }
        return { id: m.id, data, parts: bucket.get(m.id) || [] };
      });
    } catch {
      return [];
    }
  }

  async getActivity(threadId) {
    if (this.turns.isRunning("opencode", threadId)) {
      return { activity: "running", lastActivityAt: new Date().toISOString() };
    }
    const db = await this.db();
    if (db) {
      try {
        let row = null;
        if (this._hasV2(db)) {
          row =
            db
              .prepare(
                // Restrict to user/assistant: synthetic/compaction rows are
                // written mid-turn, so polling them would misreport a live
                // (TUI-started) session as completed.
                `SELECT type, data, time_updated FROM session_message
                 WHERE session_id = ? AND type IN ('user', 'assistant')
                 ORDER BY seq DESC, id DESC LIMIT 1`,
              )
              .get(threadId) || null;
          if (row) row.isV2 = true;
        }
        if (!row) {
          row = db
            .prepare(
              `SELECT data, time_updated FROM message WHERE session_id = ? ORDER BY time_created DESC, id DESC LIMIT 1`,
            )
            .get(threadId);
        }
        if (!row) return { activity: "idle", lastActivityAt: null };
        let data = {};
        try {
          data = JSON.parse(row.data);
        } catch {}
        if (row.isV2) data.role = row.type; // v2 keeps the role in a column, not the JSON
        const lastActivityAt = msIso(
          data.time?.completed || data.time?.created || row.time_updated,
        );
        const running =
          data.role === "assistant" &&
          !data.time?.completed &&
          Date.now() - (data.time?.created || 0) < RUNNING_WINDOW_MS;
        const failed = !!data.error;
        return { activity: running ? "running" : failed ? "failed" : "completed", lastActivityAt };
      } catch {}
    }
    return { activity: "idle", lastActivityAt: null };
  }

  async listModels() {
    // `opencode models` prints one provider/model per line.
    return new Promise((resolve) => {
      let p;
      try {
        p = spawn(binPath("opencode"), ["models"], {
          env: agentEnv(),
          stdio: ["ignore", "pipe", "ignore"],
          windowsHide: true,
        });
      } catch {
        return resolve([]);
      }
      let out = "";
      const t = setTimeout(() => {
        try {
          p.kill("SIGKILL");
        } catch {}
      }, 10_000);
      p.stdout.on("data", (d) => {
        if (out.length < 262_144) out += d;
      });
      p.on("close", () => {
        clearTimeout(t);
        resolve(
          out
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l && l.includes("/") && !l.includes(" "))
            .slice(0, 200)
            .map((id) => ({
              id,
              name: id,
              description: null,
              isDefault: false,
              deprecated: false,
            })),
        );
      });
      p.on("error", () => {
        clearTimeout(t);
        resolve([]);
      });
    });
  }

  /**
   * `opencode run --format json` — the output event schema isn't verified on a
   * live binary here, so parsing is defensive: we surface streamed text parts
   * when recognizable and rely on the post-turn history refetch for fidelity.
   */
  startTurn({ threadId, text, cwd, model }, onEvent) {
    this.turns.assertCapacity();
    const resume = threadId && /^ses_/.test(threadId);
    const args = ["run", "--format", "json"];
    if (resume) args.push("-s", threadId);
    if (model) args.push("-m", model);
    args.push(text);

    let child;
    try {
      child = spawn(binPath("opencode"), args, {
        cwd: cwd && existsSync(cwd) ? cwd : os.homedir(),
        env: agentEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (e) {
      return failedTurn(threadId, `opencode failed to start: ${e?.message || e}`, onEvent);
    }
    const entry = this.turns.register("opencode", [threadId || "opencode:pending"], child);

    let seq = 0;
    let realThreadId = resume ? threadId : null;
    const now = () => new Date().toISOString();
    const base = (id) => ({ id, conversationId: realThreadId, seq: ++seq, ts: now() });
    const emit = (ev) => {
      try {
        onEvent(ev);
      } catch {}
    };
    emit(userMessage(base(`opencode:input:${Date.now()}`), text));

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

    const acc = new Map(); // part id -> text so far
    const handle = (o) => {
      // Track the session id wherever it appears so fresh threads resolve.
      const sid = o.sessionID || o.session_id || o.info?.sessionID || o.part?.sessionID;
      if (!realThreadId && typeof sid === "string" && sid.startsWith("ses_")) {
        realThreadId = sid;
        this.turns.alias(entry, "opencode", sid);
      }
      // A failed turn arrives as its own line with no `part` — without this it
      // fell through the guard below and the turn ended silently.
      if (o.type === "error" || o.error) {
        const text = errorText(o.error);
        if (text) emit(systemEvent(base(`opencode:err:${seq}`), text, "error"));
        return;
      }
      const part = o.part || (o.type && o.text !== undefined ? o : null);
      if (!part) return;
      const id = part.id || `opencode:${seq}`;
      if (part.type === "text" && typeof part.text === "string") {
        const text = part.text.slice(0, 2 * 1024 * 1024);
        acc.set(id, text);
        emit(assistantMessage(base(id), text, true));
      } else if (part.type === "reasoning" && typeof part.text === "string") {
        emit(thinking(base(id), part.text));
      } else if (part.type === "tool" && part.state) {
        const callId = part.callID || id;
        // Same as the history path: edit/apply_patch carry the real unified diff
        // in state.metadata.diff (verified against opencode 1.17.4's
        // `run --format json`), while `output` is only "Edit applied successfully."
        const patch = unifiedFromOpencode(part.state.metadata?.diff, part.state.input?.filePath);
        emit(
          toolCall(base(callId), {
            name: part.tool === "bash" ? "shell" : part.tool || "tool",
            input:
              part.tool === "bash"
                ? { command: part.state.input?.command || "" }
                : patch
                  ? { filePath: part.state.input?.filePath || "" }
                  : (part.state.input ?? {}),
            status:
              part.state.status === "completed"
                ? "success"
                : part.state.status === "error"
                  ? "error"
                  : "running",
          }),
        );
        if (part.state.status === "running") return;
        if (patch) {
          emit(
            toolResult(base(`${callId}:o`), {
              toolCallId: callId,
              content: { kind: "diff", path: part.state.input?.filePath || "", patch },
              isError: part.state.status === "error",
            }),
          );
        } else if (part.state.output) {
          emit(
            toolResult(base(`${callId}:o`), {
              toolCallId: callId,
              content: { kind: "text", text: String(part.state.output).slice(0, 200_000) },
              isError: part.state.status === "error",
            }),
          );
        }
      }
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
      acc.clear();
      if (code !== 0 && !settled) {
        emit(
          systemEvent(
            base("opencode:err"),
            `opencode exited (${code}): ${stderrTail.trim().slice(-500)}`,
            "error",
          ),
        );
      }
      finish();
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      emit(
        systemEvent(base("opencode:err"), `opencode failed to start: ${e?.message || e}`, "error"),
      );
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

  // --- legacy JSON file-store fallback ---------------------------------------

  _listThreadsFiles() {
    const root = path.join(STORE_DIR, "session");
    const out = [];
    let projects;
    try {
      projects = readdirSync(root);
    } catch {
      return out;
    }
    for (const proj of projects) {
      let files;
      try {
        files = readdirSync(path.join(root, proj));
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.startsWith("ses_") || !f.endsWith(".json")) continue;
        try {
          const s = JSON.parse(readFileSync(path.join(root, proj, f), "utf8"));
          if (s.parentID) continue; // sub-sessions mirror the db's parent_id filter
          out.push({
            id: s.id || f.slice(0, -5),
            filePath: path.join(root, proj, f),
            cwd: s.directory || null,
            name: s.title || null,
            preview: s.title || null,
            createdAt: msIso(s.time?.created),
            updatedAt: msIso(s.time?.updated),
            gitBranch: null,
            sizeBytes: 0,
          });
        } catch {}
      }
    }
    return out.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  }

  _messagesFiles(threadId) {
    const msgDir = path.join(STORE_DIR, "message", threadId);
    let files;
    try {
      files = readdirSync(msgDir)
        .filter((f) => f.startsWith("msg_"))
        .sort();
    } catch {
      return [];
    }
    const out = [];
    for (const f of files) {
      try {
        const data = JSON.parse(readFileSync(path.join(msgDir, f), "utf8"));
        const msgId = data.id || f.slice(0, -5);
        const partDir = path.join(STORE_DIR, "part", msgId);
        let parts = [];
        try {
          parts = readdirSync(partDir)
            .filter((p) => p.startsWith("prt_"))
            .sort()
            .map((p) => ({
              id: p.slice(0, -5),
              data: JSON.parse(readFileSync(path.join(partDir, p), "utf8")),
            }));
        } catch {}
        out.push({ id: msgId, data, parts });
      } catch {}
    }
    return out;
  }
}

function msIso(ms) {
  return typeof ms === "number" && ms > 0 ? new Date(ms).toISOString() : null;
}

/** v2 tool state carries output as content blocks ([{type:"text",text}]);
 *  flatten to the plain string legacy parts used. On failure the blocks are
 *  null and the message lives in state.error — surface that instead. */
function v2ToolOutput(st) {
  const c = st.content ?? st.output;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    const text = c
      .map((b) => (b && b.type === "text" && typeof b.text === "string" ? b.text : ""))
      .filter(Boolean)
      .join("\n");
    if (text) return text;
  }
  if (st.status === "error") return st.error?.message || "tool failed";
  return "";
}

/**
 * Undo the quoting `opencode run` applies to a prompt before storing it.
 *
 * A prompt sent through `run` (every turn Pounce starts) comes back out of the
 * store wrapped in double quotes with inner quotes backslash-escaped — measured
 * on a real store: 19 of 1083 user prompts were wrapped, and every one of them
 * was `run`-invoked; the 1064 typed in opencode's own TUI were untouched. It is
 * NOT JSON: literal newlines survive unescaped, so `JSON.parse` both fails on
 * multi-line prompts and would wreck a backslash in a single-line one.
 *
 * This cost more than a stray pair of quotes on screen. Session.tsx matches a
 * fetched user_message to the streamed one by exact text, so the quoted copy
 * never matched and the transcript showed the prompt TWICE — once as sent, once
 * as stored.
 *
 * Only unwraps when the body has no BARE double quote, which is the invariant
 * that wrapping guarantees. A TUI prompt that is itself one fully-quoted phrase
 * is indistinguishable and loses its outer quotes; that is cosmetic, and rarer
 * than every headless prompt being wrong.
 */
function unwrapRunPrompt(text) {
  if (typeof text !== "string" || text.length < 2) return text;
  if (!text.startsWith('"') || !text.endsWith('"')) return text;
  const inner = text.slice(1, -1);
  if (/(?:^|[^\\])"/.test(inner)) return text;
  return inner.replace(/\\"/g, '"');
}

/**
 * Readable one-liner for an opencode error object.
 *
 * opencode reports a failed turn two ways and BOTH used to be dropped on the
 * floor: `run --format json` prints a top-level `{type:"error", error:{…}}`
 * line (no `part`, so the stream handler skipped it), and the store hangs the
 * same object off the assistant message as `data.error` (the history reader
 * only walked `parts`). The turn therefore ended with nothing but the user's
 * own message in the transcript — which the app can only render as an empty
 * thread, so a billing failure looked exactly like a hang.
 *
 * Shape: `{name, data:{message, statusCode?, …}}`. The name alone ("APIError",
 * "UnknownError") says nothing, so it only leads when there is no message.
 */
function errorText(err) {
  if (!err) return null;
  if (typeof err === "string") return err.trim() || null;
  const name = typeof err.name === "string" ? err.name : null;
  const raw = err.data?.message ?? err.message;
  const msg = typeof raw === "string" ? raw.trim() : "";
  const code = err.data?.statusCode;
  if (!msg) return name ? `${name}${code ? ` (${code})` : ""}` : "The agent reported an error.";
  return `${msg}${code ? ` (${code})` : ""}`;
}

/**
 * Normalize opencode's `state.metadata.diff` for the app's diff viewer.
 *
 * opencode emits Subversion-flavoured unified diffs:
 *   Index: /abs/path
 *   ===================================================================
 *   --- /abs/path
 *   +++ /abs/path
 *   @@ -1,3 +1,4 @@
 * splitPatch() keys on `diff --git`, so without a synthetic header the whole
 * patch collapses into one unnamed file. The `Index:`/`===` preamble isn't
 * recognised as diff metadata either, so it would render as context lines.
 * Returns "" when there is no hunk content to show.
 */
function unifiedFromOpencode(diff, filePath) {
  if (typeof diff !== "string" || !diff.includes("@@")) return "";
  const body = diff
    .split("\n")
    .filter((l) => !l.startsWith("Index: ") && !/^=+$/.test(l))
    .join("\n");
  const p = filePath || /^---\s+(.+)$/m.exec(body)?.[1]?.trim() || "file";
  return `diff --git a/${p} b/${p}\n${body}`;
}

function failedTurn(threadId, message, onEvent) {
  try {
    onEvent({
      id: `${threadId || "opencode"}:spawn-err`,
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
