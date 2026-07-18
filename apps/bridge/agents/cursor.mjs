/**
 * Cursor CLI adapter — reads sessions from cursor-agent's own store and drives
 * turns via `cursor-agent -p --output-format stream-json`.
 *
 * Store layout (reverse-engineered against cursor-agent 2026.07.16, since the
 * format is undocumented and "may change without notice"):
 *   ~/.cursor/chats/<projectHash>/<chatId>/store.db  — one sqlite per chat.
 *     meta(key TEXT, value TEXT)  — row key "0" holds hex-encoded JSON:
 *        { agentId, latestRootBlobId, name, mode, createdAt }.
 *     blobs(id TEXT, data BLOB)   — a content-addressed Merkle DAG. Message
 *        blobs are UTF-8 JSON in Vercel-AI-SDK shape ({role, content[]} with
 *        text / tool-call / tool-result / redacted-reasoning parts); the rest
 *        are protobuf DAG nodes. The blob named by `latestRootBlobId` is a
 *        protobuf whose repeated field 1 (32-byte refs) lists the message blob
 *        ids IN CONVERSATION ORDER, and whose field 9 is the workspace file://
 *        URI. We walk that ordered list — no protobuf schema needed beyond a
 *        top-level field scan. Read-only via node:sqlite (safe alongside a
 *        writing cursor-agent). Reasoning is stored redacted (opaque), so
 *        history shows no thinking; the LIVE stream still carries real thinking.
 */
import { existsSync, readdirSync, statSync, watch } from "node:fs";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
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
import { agentEnv, binVersion, binPath, liveAgentCwds } from "./env.mjs";

// node:sqlite loaded via createRequire (native Node resolution): a plain
// `import("node:sqlite")` is rewritten by vite-node under tests and fails on
// this newer builtin. Works identically in production.
const nodeRequire = createRequire(import.meta.url);

const BIN = "cursor-agent";
const CHATS_DIR = path.join(os.homedir(), ".cursor", "chats");
const RUNNING_WINDOW_MS = 120_000;
const LIVE_EXTENDED_WINDOW_MS = 2 * 60 * 60_000;
const TURN_TIMEOUT_MS = Number(process.env.BRIDGE_TURN_TIMEOUT_MS || 300_000);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class CursorAdapter {
  constructor({ turns }) {
    this.id = "cursor";
    this.displayName = "Cursor";
    this.description = "Cursor Agent CLI";
    // thinking:true — the live stream emits real reasoning deltas (history is
    // redacted). images:false — the headless CLI has no image-input path here.
    this.capabilities = {
      streaming: true,
      tools: true,
      images: false,
      thinking: true,
      terminal: true,
      git: true,
    };
    this.turns = turns;
    this._sqlite = undefined; // undefined = not tried, null = unavailable
    this._dirty = new Set();
    this._watcher = null;
    this._watchTimer = null;
    this._loc = new Map(); // chatId -> store.db path (populated by listThreads/locate)
    this._auth = null; // { at, promise } — cached auth probe (see authStatus)
  }

  onDirty(cb) {
    this._dirty.add(cb);
    this._watch();
  }

  async isAvailable() {
    // "Available" = usable: the binary runs AND the CLI is signed in. An
    // installed-but-unauthed cursor can't take turns, so it drops out of
    // /v1/agents (and thus the New/filter pickers). Diagnostics still shows it
    // as installed + "not signed in" (doctor keys off `installed`, not this).
    if ((await binVersion(BIN)) == null) return false;
    return (await this.authStatus()).authenticated;
  }

  /**
   * Cursor is the one agent that hard-requires an authenticated CLI — turns
   * block until `cursor-agent login` (browser OAuth) or CURSOR_API_KEY is set —
   * so diagnostics surface "installed but not signed in" like gh does. Parses
   * `cursor-agent status` stdout ("✓ Logged in as <email>" / "Not logged in").
   * Returns { required, authenticated, account } (never throws). Cached ~60s
   * since isAvailable (every /v1/agents) and the doctor both call it.
   */
  authStatus() {
    if (this._auth && Date.now() - this._auth.at < 60_000) return this._auth.promise;
    const promise = this._probeAuth();
    this._auth = { at: Date.now(), promise };
    return promise;
  }

  async _probeAuth() {
    if (agentEnv().CURSOR_API_KEY)
      return { required: true, authenticated: true, account: "CURSOR_API_KEY" };
    const out = await new Promise((resolve) => {
      let p;
      try {
        p = spawn(binPath(BIN), ["status"], {
          env: agentEnv(),
          stdio: ["ignore", "pipe", "ignore"],
          windowsHide: true,
        });
      } catch {
        return resolve(null);
      }
      let s = "";
      const t = setTimeout(() => {
        try {
          p.kill("SIGKILL");
        } catch {}
      }, 5000);
      p.stdout.on("data", (d) => {
        if (s.length < 4096) s += d;
      });
      p.on("close", () => {
        clearTimeout(t);
        resolve(s);
      });
      p.on("error", () => {
        clearTimeout(t);
        resolve(null);
      });
    });
    return parseAuthStatus(out);
  }

  /** Lazily load node:sqlite once; null when the runtime lacks it (history off,
   *  turns still work). */
  async _sqliteMod() {
    if (this._sqlite !== undefined) return this._sqlite;
    try {
      this._sqlite = nodeRequire("node:sqlite").DatabaseSync;
    } catch {
      this._sqlite = null;
    }
    return this._sqlite;
  }

  _watch() {
    if (this._watcher || !existsSync(CHATS_DIR)) return;
    try {
      // A chat's store.db (+ -wal) sits at <hash>/<chatId>/store.db, so the
      // changed path names the thread — invalidate precisely, debounced.
      this._watcher = watch(CHATS_DIR, { recursive: true }, (_e, rel) => {
        if (!rel || !path.basename(rel).startsWith("store.db")) return;
        const chatId = path.basename(path.dirname(rel));
        clearTimeout(this._watchTimer);
        this._watchTimer = setTimeout(() => {
          for (const cb of this._dirty) {
            try {
              cb(chatId);
            } catch {}
          }
        }, 800);
      });
    } catch {}
  }

  /** All chat store.db paths, newest first, as { chatId, dbPath, mtimeMs }. */
  _stores() {
    const out = [];
    let hashes;
    try {
      hashes = readdirSync(CHATS_DIR);
    } catch {
      return out;
    }
    for (const h of hashes) {
      let chats;
      try {
        chats = readdirSync(path.join(CHATS_DIR, h));
      } catch {
        continue;
      }
      for (const chatId of chats) {
        const dbPath = path.join(CHATS_DIR, h, chatId, "store.db");
        let st;
        try {
          st = statSync(dbPath);
        } catch {
          continue;
        }
        this._loc.set(chatId, dbPath);
        out.push({ chatId, dbPath, mtimeMs: st.mtimeMs, createdMs: st.birthtimeMs || st.mtimeMs });
      }
    }
    return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  _dbPath(chatId) {
    const cached = this._loc.get(chatId);
    if (cached && existsSync(cached)) return cached;
    this._stores(); // refresh the map
    return this._loc.get(chatId) || null;
  }

  async _open(dbPath) {
    const DatabaseSync = await this._sqliteMod();
    if (!DatabaseSync || !dbPath || !existsSync(dbPath)) return null;
    try {
      return new DatabaseSync(dbPath, { readOnly: true });
    } catch {
      return null;
    }
  }

  async listThreads() {
    const stores = this._stores();
    if (!stores.length) return [];
    const out = [];
    for (const { chatId, dbPath, mtimeMs, createdMs } of stores.slice(0, 1000)) {
      const db = await this._open(dbPath);
      if (!db) continue;
      try {
        const meta = readMeta(db);
        const root = meta?.latestRootBlobId ? getBlob(db, meta.latestRootBlobId) : null;
        const scan = root ? scanRoot(root) : { ids: [], cwd: null };
        const preview = firstUserQuery(db, scan.ids);
        const name = meta?.name && meta.name !== "New Agent" ? meta.name : preview;
        out.push({
          id: chatId,
          filePath: dbPath,
          cwd: scan.cwd || null,
          name: name || null,
          preview: preview || null,
          createdAt: msIso(meta?.createdAt) || new Date(createdMs).toISOString(),
          updatedAt: new Date(mtimeMs).toISOString(),
          gitBranch: null,
          sizeBytes: 0,
        });
      } catch {
      } finally {
        try {
          db.close();
        } catch {}
      }
    }
    return out;
  }

  async getEvents(threadId, { limit } = {}) {
    const db = await this._open(this._dbPath(threadId));
    if (!db) return [];
    try {
      const meta = readMeta(db);
      const root = meta?.latestRootBlobId ? getBlob(db, meta.latestRootBlobId) : null;
      if (!root) return [];
      const ids = scanRoot(root).ids;

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
      const base = (id) => ({ id, conversationId: threadId, seq: 0, ts: null });

      for (const bid of ids) {
        const raw = getBlob(db, bid);
        if (!raw) continue;
        let msg;
        try {
          msg = JSON.parse(Buffer.from(raw).toString("utf8"));
        } catch {
          continue;
        }
        const role = msg.role;
        if (role === "system") continue;

        if (role === "user") {
          // String content = injected <user_info>/rules context → noise. Array
          // content = the real turn (a <user_query>…</user_query> envelope).
          if (typeof msg.content === "string") continue;
          const text = userQueryText(partsText(msg.content));
          if (text) add(userMessage(base(bid), text), true);
          continue;
        }
        if (role === "assistant") {
          for (const [i, p] of asArr(msg.content).entries()) {
            if (p?.type === "text" && p.text?.trim()) {
              add(assistantMessage(base(`${bid}:${i}`), p.text));
            } else if (p?.type === "reasoning" && p.text?.trim()) {
              add(thinking(base(`${bid}:${i}`), p.text)); // plaintext reasoning (rare); redacted-reasoning skipped
            } else if (p?.type === "tool-call") {
              add(toolCall(base(p.toolCallId || `${bid}:${i}`), shapeCall(p)));
            }
          }
          continue;
        }
        if (role === "tool") {
          for (const p of asArr(msg.content)) {
            if (p?.type !== "tool-result") continue;
            const callId = p.toolCallId || bid;
            add(
              toolResult(base(`${callId}:o`), {
                toolCallId: callId,
                content: { kind: "text", text: resultText(p).slice(0, 200_000) },
                isError: isErrorResult(p),
              }),
            );
          }
        }
      }

      const events = turns.flat();
      events.forEach((ev, i) => {
        ev.seq = i + 1;
      });
      return events;
    } finally {
      try {
        db.close();
      } catch {}
    }
  }

  async getActivity(threadId) {
    if (this.turns.isRunning("cursor", threadId)) {
      return { activity: "running", lastActivityAt: new Date().toISOString() };
    }
    const dbPath = this._dbPath(threadId);
    if (!dbPath) return { activity: "idle", lastActivityAt: null };
    let mtimeMs;
    try {
      mtimeMs = statSync(dbPath).mtimeMs;
    } catch {
      return { activity: "idle", lastActivityAt: null };
    }
    const lastActivityAt = new Date(mtimeMs).toISOString();
    // A live cursor-agent in the thread's cwd keeps a quiet mid-turn "running";
    // its absence demotes immediately; unknown falls back to the mtime window.
    let cwd = null;
    const db = await this._open(dbPath);
    if (db) {
      try {
        const meta = readMeta(db);
        const root = meta?.latestRootBlobId ? getBlob(db, meta.latestRootBlobId) : null;
        cwd = root ? scanRoot(root).cwd : null;
      } catch {
      } finally {
        try {
          db.close();
        } catch {}
      }
    }
    const live = cwd ? await liveAgentCwds() : null;
    const liveInCwd = cwd && live ? (live.get(BIN)?.has(cwd) ?? false) : null;
    const recent =
      liveInCwd !== false &&
      Date.now() - mtimeMs < (liveInCwd ? LIVE_EXTENDED_WINDOW_MS : RUNNING_WINDOW_MS);
    return { activity: recent && liveInCwd ? "running" : "completed", lastActivityAt };
  }

  listModels() {
    // `cursor-agent --list-models` prints "  <id> - <Name>" lines after a header.
    return new Promise((resolve) => {
      let p;
      try {
        p = spawn(binPath(BIN), ["--list-models"], {
          env: agentEnv(),
          stdio: ["ignore", "pipe", "ignore"],
          windowsHide: true,
        });
      } catch {
        return resolve(defaultModels());
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
        const models = [];
        for (const line of out.split("\n")) {
          const m = line.match(/^\s*([a-z0-9][\w.-]*)\s+-\s+(.+?)\s*$/i);
          if (!m) continue;
          const id = m[1];
          models.push({
            id,
            name: m[2],
            description: null,
            isDefault: id === "auto",
            deprecated: false,
          });
        }
        resolve(models.length ? models.slice(0, 200) : defaultModels());
      });
      p.on("error", () => {
        clearTimeout(t);
        resolve(defaultModels());
      });
    });
  }

  /**
   * `cursor-agent -p --output-format stream-json --stream-partial-output` emits
   * NDJSON: system/init (carries session_id), user (our echo), thinking
   * delta/completed, tool_call started/completed, assistant (text deltas),
   * result/success. `--force --trust` run headless without approval prompts;
   * `--resume <chatId>` continues an existing chat. History refetch backstops
   * any parsing gap.
   */
  startTurn({ threadId, text, cwd, permissionMode, model }, onEvent) {
    this.turns.assertCapacity();
    const resume = threadId && UUID_RE.test(threadId);
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--stream-partial-output",
      "--force",
      "--trust",
    ];
    if (resume) args.push("--resume", threadId);
    if (permissionMode === "plan") args.push("--mode", "plan");
    if (model && model !== "auto") args.push("--model", model);
    args.push(text);

    let child;
    try {
      child = spawn(binPath(BIN), args, {
        cwd: cwd && existsSync(cwd) ? cwd : os.homedir(),
        env: agentEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (e) {
      return failedTurn(threadId, `cursor-agent failed to start: ${e?.message || e}`, onEvent);
    }
    const entry = this.turns.register("cursor", [threadId || "cursor:pending"], child);

    let seq = 0;
    let realThreadId = resume ? threadId : null;
    const now = () => new Date().toISOString();
    const base = (id) => ({ id, conversationId: realThreadId, seq: ++seq, ts: now() });
    const emit = (ev) => {
      try {
        onEvent(ev);
      } catch {}
    };
    emit(userMessage(base(`cursor:input:${Date.now()}`), text));

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

    // Assistant text streams as deltas with no id — accumulate into one message
    // per segment; a tool call or a completed thinking block starts a new one.
    let seg = 0;
    let asst = "";
    let think = "";
    const asstId = () => `cursor:asst:${seg}`;
    const thinkId = () => `cursor:think:${seg}`;
    const breakSegment = () => {
      if (asst || think) seg++;
      asst = "";
      think = "";
    };

    const handle = (o) => {
      const t = o.type;
      if (t === "system" && o.subtype === "init") {
        if (!realThreadId && typeof o.session_id === "string") {
          realThreadId = o.session_id;
          this.turns.alias(entry, "cursor", realThreadId);
        }
        return;
      }
      if (t === "user") return; // echo of our prompt — already emitted
      if (t === "thinking") {
        if (o.subtype === "delta" && typeof o.text === "string") {
          think += o.text;
          emit(thinking(base(thinkId()), think));
        } else if (o.subtype === "completed") {
          breakSegment();
        }
        return;
      }
      if (t === "assistant") {
        const txt = (o.message?.content || [])
          .map((c) => (c?.type === "text" ? c.text || "" : ""))
          .join("");
        if (!txt) return;
        // Deltas carry timestamp_ms and accumulate; the trailing aggregate event
        // (no timestamp_ms) restates the full segment text — replace, don't append.
        if (o.timestamp_ms != null) {
          asst += txt;
          emit(assistantMessage(base(asstId()), asst, true));
        } else {
          asst = txt;
          emit(assistantMessage(base(asstId()), asst, false));
        }
        return;
      }
      if (t === "tool_call") {
        const call = o.tool_call || {};
        const callId = o.call_id || `cursor:tool:${seq}`;
        const { name, input, result, isError } = shapeStreamCall(call);
        if (o.subtype === "started") breakSegment();
        emit(
          toolCall(base(callId), {
            name,
            input,
            status: o.subtype === "completed" ? (isError ? "error" : "success") : "running",
          }),
        );
        if (o.subtype === "completed" && result != null) {
          emit(
            toolResult(base(`${callId}:o`), {
              toolCallId: callId,
              content: { kind: "text", text: String(result).slice(0, 200_000) },
              isError: !!isError,
            }),
          );
        }
        return;
      }
      if (t === "result") {
        if (o.is_error) {
          emit(
            systemEvent(
              base(`cursor:err:${seq}`),
              String(o.result || o.error || "turn failed"),
              "error",
            ),
          );
        } else if (!asst && typeof o.result === "string" && o.result.trim()) {
          // Fallback only: if no assistant text streamed (e.g. a tool-only turn),
          // surface the authoritative final result text.
          emit(assistantMessage(base(asstId()), o.result, false));
        }
        finish();
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
      if (code !== 0 && !settled) {
        emit(
          systemEvent(
            base("cursor:err"),
            `cursor-agent exited (${code}): ${stderrTail.trim().slice(-500)}`,
            "error",
          ),
        );
      }
      finish();
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      emit(
        systemEvent(
          base("cursor:err"),
          `cursor-agent failed to start: ${e?.message || e}`,
          "error",
        ),
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
}

// --- store helpers -----------------------------------------------------------

function readMeta(db) {
  try {
    const row =
      db.prepare("SELECT value FROM meta WHERE key = '0'").get() ||
      db.prepare("SELECT value FROM meta LIMIT 1").get();
    if (!row?.value) return null;
    return JSON.parse(Buffer.from(row.value, "hex").toString("utf8"));
  } catch {
    return null;
  }
}

function getBlob(db, id) {
  try {
    return db.prepare("SELECT data FROM blobs WHERE id = ?").get(id)?.data ?? null;
  } catch {
    return null;
  }
}

/**
 * Scan a root blob's TOP-LEVEL protobuf fields (no recursion, no schema): field
 * 1 length-delimited 32-byte chunks are the message blob ids in order; field 9
 * length-delimited utf8 is the workspace `file://` URI. Nested hashes live
 * inside other fields' chunks, which we skip over wholesale — so field 1 stays
 * exactly the ordered message list.
 */
export function scanRoot(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const ids = [];
  let cwd = null;
  let i = 0;
  const n = b.length;
  const varint = () => {
    let r = 0,
      s = 0;
    while (i < n) {
      const x = b[i++];
      r += (x & 0x7f) * 2 ** s;
      s += 7;
      if (!(x & 0x80)) break;
    }
    return r;
  };
  while (i < n) {
    const tag = varint();
    const field = tag >>> 3,
      wt = tag & 7;
    if (wt === 0) {
      varint();
    } else if (wt === 2) {
      const len = varint();
      const start = i;
      i += len;
      if (field === 1 && len === 32) ids.push(b.subarray(start, start + 32).toString("hex"));
      else if (field === 9 && cwd == null) {
        const s = b.subarray(start, start + len).toString("utf8");
        if (s.startsWith("file://")) {
          try {
            cwd = decodeURIComponent(s.replace(/^file:\/\//, ""));
          } catch {
            cwd = s.replace(/^file:\/\//, "");
          }
        }
      }
    } else if (wt === 5) i += 4;
    else if (wt === 1) i += 8;
    else break;
  }
  return { ids, cwd };
}

/** The first real user-query text among the ordered message blobs (for preview). */
function firstUserQuery(db, ids) {
  for (const bid of ids) {
    const raw = getBlob(db, bid);
    if (!raw) continue;
    let msg;
    try {
      msg = JSON.parse(Buffer.from(raw).toString("utf8"));
    } catch {
      continue;
    }
    if (msg.role !== "user" || typeof msg.content === "string") continue;
    const text = userQueryText(partsText(msg.content));
    if (text) return text.slice(0, 200);
  }
  return null;
}

const asArr = (c) => (Array.isArray(c) ? c : []);
const partsText = (content) =>
  asArr(content)
    .map((p) => (p?.type === "text" ? p.text || "" : ""))
    .join("");

/** Pull the inner text of a <user_query>…</user_query> envelope, else the whole
 *  (trimmed) text — mirrors codex's injected-context stripping. */
export function userQueryText(text) {
  if (!text) return "";
  const m = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
  return (m ? m[1] : text).trim();
}

/** Shape a stored tool-call part → the app's {name, input, status}. */
export function shapeCall(p) {
  const name = p.toolName || "tool";
  const args = p.args || {};
  if (name === "Shell" || name === "shell") {
    return { name: "shell", input: { command: String(args.command || "") }, status: "success" };
  }
  return { name, input: args, status: "success" };
}

/** A stored tool-result part → display text. */
export function resultText(p) {
  if (typeof p.result === "string") return p.result;
  const exp = asArr(p.experimental_content).find((c) => c?.type === "text");
  if (exp?.text) return exp.text;
  return p.result == null ? "" : JSON.stringify(p.result);
}

export function isErrorResult(p) {
  const hl = p.providerOptions?.cursor?.highLevelToolCallResult;
  return !!hl?.isError;
}

/** A live-stream tool_call.<kind>ToolCall → {name, input, result, isError}. */
export function shapeStreamCall(call) {
  const key = Object.keys(call).find((k) => k.endsWith("ToolCall"));
  const tc = (key && call[key]) || {};
  const args = tc.args || {};
  const isShell = key === "shellToolCall";
  const name = isShell ? "shell" : key ? key.replace(/ToolCall$/, "") : "tool";
  const input = isShell ? { command: String(args.command || "") } : args;
  let result = null,
    isError = false;
  const r = tc.result;
  if (r && typeof r === "object") {
    if (r.error != null) {
      isError = true;
      result = typeof r.error === "string" ? r.error : JSON.stringify(r.error);
    } else if (r.success) {
      const s = r.success;
      result = s.stdout ?? s.interleavedOutput ?? s.output ?? s.contents ?? JSON.stringify(s);
    }
  }
  return { name, input, result, isError };
}

/** Parse `cursor-agent status` stdout → { required, authenticated, account }.
 *  Null input (spawn failed) reads as not-authenticated. Note "Not logged in"
 *  contains "logged in", so the negative guard must win. */
export function parseAuthStatus(out) {
  if (out == null) return { required: true, authenticated: false, account: null };
  const authenticated = /logged in/i.test(out) && !/not logged in/i.test(out);
  const account = (out.match(/logged in as\s+(\S+)/i) || [])[1] || null;
  return { required: true, authenticated, account };
}

function defaultModels() {
  return [
    { id: "auto", name: "Auto", description: null, isDefault: true, deprecated: false },
    {
      id: "composer-2.5",
      name: "Composer 2.5",
      description: null,
      isDefault: false,
      deprecated: false,
    },
  ];
}

function msIso(ms) {
  return typeof ms === "number" && ms > 0 ? new Date(ms).toISOString() : null;
}

function failedTurn(threadId, message, onEvent) {
  try {
    onEvent({
      id: `${threadId || "cursor"}:spawn-err`,
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
