/**
 * OpenCode adapter — reads sessions from opencode's own store and drives turns
 * via `opencode run --format json`.
 *
 * Current opencode persists to ~/.local/share/opencode/opencode.db (sqlite,
 * WAL): session(id, directory, title, time_created, time_updated, …),
 * message(id, session_id, time_created, data JSON{role, time}), part(id,
 * message_id, session_id, data JSON{type: text|reasoning|tool|step-*}).
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
    this._dirty = new Set();
    this._watcher = null;
    this._watchTimer = null;
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
        const { DatabaseSync } = await import("node:sqlite");
        this._db = new DatabaseSync(DB_FILE, { readOnly: true });
        this._watchDb();
      }
    } catch {
      this._db = null; // e.g. runtime without node:sqlite — file-store fallback below
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
      try {
        const rows = db
          .prepare(
            `SELECT id, directory, title, time_created, time_updated
             FROM session WHERE parent_id IS NULL AND time_archived IS NULL
             ORDER BY time_updated DESC LIMIT 1000`,
          )
          .all();
        return rows.map((r) => ({
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
      } catch {}
    }
    return this._listThreadsFiles();
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

    for (const { data, parts } of messages) {
      const role = data.role;
      const ts = msIso(data.time?.created) || new Date().toISOString();
      for (const part of parts) {
        const base = { id: part.id, conversationId: threadId, seq: 0, ts };
        const d = part.data;
        if (d.type === "text" && d.text?.trim()) {
          if (role === "user") add(userMessage(base, d.text), true);
          else add(assistantMessage(base, d.text));
        } else if (d.type === "reasoning" && d.text?.trim()) {
          add(thinking(base, d.text));
        } else if (d.type === "tool") {
          const callId = d.callID || part.id;
          const st = d.state || {};
          add(
            toolCall(
              { ...base, id: callId },
              {
                name: d.tool === "bash" ? "shell" : d.tool || "tool",
                input: d.tool === "bash" ? { command: st.input?.command || "" } : (st.input ?? {}),
                status: st.status === "error" ? "error" : "success",
              },
            ),
          );
          if (st.output) {
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
        }
        // step-start / step-finish / snapshot parts: plumbing, skipped.
      }
    }

    const events = turns.flat();
    events.forEach((ev, i) => {
      ev.seq = i + 1;
    });
    return events;
  }

  _messagesDb(db, threadId) {
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
        return { data, parts: bucket.get(m.id) || [] };
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
        const row = db
          .prepare(
            `SELECT data, time_updated FROM message WHERE session_id = ? ORDER BY time_created DESC, id DESC LIMIT 1`,
          )
          .get(threadId);
        if (!row) return { activity: "idle", lastActivityAt: null };
        let data = {};
        try {
          data = JSON.parse(row.data);
        } catch {}
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
        emit(
          toolCall(base(callId), {
            name: part.tool === "bash" ? "shell" : part.tool || "tool",
            input:
              part.tool === "bash"
                ? { command: part.state.input?.command || "" }
                : (part.state.input ?? {}),
            status:
              part.state.status === "completed"
                ? "success"
                : part.state.status === "error"
                  ? "error"
                  : "running",
          }),
        );
        if (part.state.output && part.state.status !== "running") {
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
        out.push({ data, parts });
      } catch {}
    }
    return out;
  }
}

function msIso(ms) {
  return typeof ms === "number" && ms > 0 ? new Date(ms).toISOString() : null;
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
