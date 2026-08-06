/**
 * History for the long tail of coding CLIs, via `agent-canonical`.
 *
 * We hand-roll claude, codex, opencode and cursor because fidelity there is the
 * product: thinking, images, permissions, compaction notes, per-thread usage,
 * live activity, and driving turns. None of that is worth re-deriving for CLIs
 * nobody here runs — so the other nine dialects that package knows about
 * (gemini, qwen, kilo, goose, cline, copilot, pi, droid, vibe) are read through
 * its parsers instead, at whatever fidelity they offer.
 *
 * What that fidelity is, measured by running their claude-code parser over a
 * real 1104-message transcript: sessions carry projectPath / gitBranch / model /
 * startedAt / title, and messages are {turn, role, text, toolCalls[], ts, usage}
 * with each call's name, args, callId and output. No reasoning, no images, no
 * system events, no permission prompts. Good enough to READ a session; not good
 * enough to be how we treat an agent someone actually uses.
 *
 * Deliberately limited, and honest about it:
 *   - READ-ONLY. These adapters take no turns (`canTurn: false`); the composer
 *     hides its send affordance rather than failing a message you typed.
 *   - UNVERIFIED against real stores. None of these CLIs is installed on any
 *     machine we develop on, so this is best-effort by construction: it either
 *     works for someone who has one, or they file an issue with a real
 *     transcript and we fix it against that.
 *   - The version is PINNED exactly. A 0-star dependency breaking must never be
 *     able to reach the four agents that matter.
 *
 * Their parser reads a whole file eagerly and keeps `rawEvents` (26.7 MB in
 * memory for that 1104-message session), so we drop it after mapping and skip
 * files past MAX_BYTES rather than let a huge transcript sit in the cache.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { userMessage, assistantMessage, toolCall, toolResult } from "./events.mjs";
import { openSqliteReadOnly } from "./sqlite.mjs";

/** One entry per dialect we defer to. `store` is relative to $HOME. */
const DIALECTS = [
  { id: "gemini", name: "Gemini CLI", store: ".gemini/tmp", match: /\.jsonl$/ },
  { id: "qwen", name: "Qwen Code", store: ".qwen/projects", match: /\.jsonl$/ },
  { id: "copilot", name: "Copilot CLI", store: ".copilot/session-state", match: /events\.jsonl$/ },
  { id: "pi", name: "Pi", store: ".pi/agent/sessions", match: /\.jsonl$/ },
  { id: "droid", name: "Droid", store: ".factory/sessions", match: /\.jsonl$/ },
  { id: "cline", name: "Cline", store: ".cline/data/sessions", match: /\.messages\.json$/ },
  { id: "vibe", name: "Vibe", store: ".vibe/logs/session", match: /messages\.jsonl$/ },
  // sqlite-backed: their parser takes a DB handle, so our own opener serves it
  // and no native dependency is added.
  //
  // goose's own dialect says only "<Goose data dir>/sessions" — it follows XDG
  // on Linux and may not on macOS — so both candidates are tried and the first
  // that exists wins, rather than betting on one.
  {
    id: "goose",
    name: "Goose",
    store: [".local/share/goose/sessions", "Library/Application Support/goose/sessions"],
    db: "sessions.db",
  },
  { id: "kilo", name: "Kilo Code", store: ".local/share/kilo", db: "kilo.db" },
];

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_SESSIONS = 500;
const MAX_DEPTH = 5;

/** Recursively collect matching transcript files, bounded in depth and count. */
function walk(dir, match, out = [], depth = 0) {
  if (depth > MAX_DEPTH || out.length >= MAX_SESSIONS) return out;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (out.length >= MAX_SESSIONS) break;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, match, out, depth + 1);
    else if (match.test(e.name)) {
      try {
        const st = statSync(full);
        if (st.size <= MAX_BYTES) out.push({ file: full, st });
      } catch {}
    }
  }
  return out;
}

/** Their canonical Session → our thread meta. */
function metaFor(session, id, file, st) {
  return {
    id,
    filePath: file,
    cwd: session?.projectPath || null,
    name: session?.title || null,
    preview: firstUserText(session)?.slice(0, 200) || null,
    createdAt: session?.startedAt || new Date(st.birthtimeMs || st.mtimeMs).toISOString(),
    updatedAt: session?.endedAt || new Date(st.mtimeMs).toISOString(),
    gitBranch: session?.gitBranch || null,
    sizeBytes: st.size,
  };
}

function firstUserText(session) {
  for (const m of session?.transcript?.messages || []) {
    if (m.role === "user" && m.text?.trim()) return m.text.trim();
  }
  return null;
}

/** Their canonical messages → our timeline events. */
function eventsFor(session, threadId) {
  const events = [];
  const base = (id, ts) => ({ id, conversationId: threadId, seq: 0, ts: ts || null });
  for (const [i, m] of (session?.transcript?.messages || []).entries()) {
    const text = (m.text || "").trim();
    if (m.role === "user") {
      if (text) events.push(userMessage(base(`u:${i}`, m.ts), text));
      continue;
    }
    if (text) events.push(assistantMessage(base(`a:${i}`, m.ts), text));
    for (const [j, c] of (m.toolCalls || []).entries()) {
      const callId = c.callId || `c:${i}:${j}`;
      events.push(
        toolCall(base(callId, m.ts), {
          name: c.name || "tool",
          input: c.args ?? {},
          status: c.exitCode ? "error" : "success",
        }),
      );
      // outputFull when the parser kept it, else the preview it always keeps.
      const out = c.outputFull ?? c.outputPreview;
      if (out != null) {
        events.push(
          toolResult(base(`${callId}:o`, m.ts), {
            toolCallId: callId,
            content: { kind: "text", text: String(out) },
            isError: Boolean(c.exitCode),
          }),
        );
      }
    }
  }
  events.forEach((e, i) => {
    e.seq = i + 1;
  });
  return events;
}

class CanonicalAdapter {
  constructor(dialect) {
    this.id = dialect.id;
    this.displayName = dialect.name;
    this.description = `${dialect.name} (history only)`;
    this.dialect = dialect;
    const candidates = [dialect.store].flat().map((s) => path.join(os.homedir(), s));
    this.root = candidates.find((p) => existsSync(p)) || candidates[0];
    this.capabilities = {
      streaming: false,
      tools: true,
      images: false,
      thinking: false,
      terminal: false,
      git: false,
      // Read-only: no turn transport exists for these, so the app must not
      // offer to send. Older clients that ignore this simply never see the
      // agent in a picker, because isAvailable gates on sessions existing.
      canTurn: false,
    };
    this._loc = new Map(); // sessionId -> file path
  }

  /** Available only when this CLI has actually written sessions here — an empty
   *  or absent store must not add a dead agent to everyone's list. */
  async isAvailable() {
    return false; // never runnable: turns are not supported (see startTurn)
  }

  /** Whether there is any history to show, which is what the thread list needs. */
  hasSessions() {
    return existsSync(this.root) && this._files().length > 0;
  }

  _files() {
    if (this.dialect.db) {
      const file = path.join(this.root, this.dialect.db);
      return existsSync(file) ? [{ file, st: statSync(file) }] : [];
    }
    return walk(this.root, this.dialect.match);
  }

  async _parsers() {
    try {
      return await import(`agent-canonical/parsers/${this.id}`);
    } catch {
      return null; // dependency absent or dialect renamed upstream
    }
  }

  /** Sessions from a sqlite dialect, via our own read-only handle. */
  async _fromDb(mod, file, st) {
    const db = openSqliteReadOnly(file);
    if (!db) return [];
    const out = [];
    try {
      for (const id of mod.listSessionIds(db).slice(0, MAX_SESSIONS)) {
        const r = await mod.parseSessionFromDb(db, id);
        if (r?.success) out.push({ session: r.data, id: `${this.id}:${id}`, file, st });
      }
    } catch {
    } finally {
      try {
        db.close();
      } catch {}
    }
    return out;
  }

  async _sessions() {
    const mod = await this._parsers();
    if (!mod) return [];
    const out = [];
    for (const { file, st } of this._files()) {
      if (this.dialect.db) {
        out.push(...(await this._fromDb(mod, file, st)));
        continue;
      }
      try {
        const r = await mod.parseSessionFile(file);
        if (!r?.success) continue;
        const session = r.data;
        // Their transcript retains every raw event; we have already mapped what
        // we need, and keeping it would put megabytes per session in the cache.
        if (session.transcript) session.transcript.rawEvents = undefined;
        out.push({ session, id: session.externalId || path.basename(file), file, st });
      } catch {}
    }
    return out;
  }

  async listThreads() {
    const out = [];
    for (const { session, id, file, st } of await this._sessions()) {
      this._loc.set(id, file);
      out.push(metaFor(session, id, file, st));
    }
    return out;
  }

  async getEvents(threadId) {
    for (const { session, id } of await this._sessions()) {
      if (id === threadId) return eventsFor(session, threadId);
    }
    return [];
  }

  async getActivity(threadId) {
    const file = this._loc.get(threadId);
    if (!file || !existsSync(file)) return { activity: "idle", lastActivityAt: null };
    return {
      activity: "completed",
      lastActivityAt: new Date(statSync(file).mtimeMs).toISOString(),
    };
  }

  /** History only. Says so as a timeline event rather than throwing, so a client
   *  that sends anyway sees an explanation instead of a dead spinner. */
  startTurn({ threadId }, onEvent) {
    try {
      onEvent({
        id: `${threadId || this.id}:read-only`,
        conversationId: threadId || null,
        seq: 1,
        ts: new Date().toISOString(),
        type: "system_event",
        message: `Pounce can read ${this.displayName} history, but can't run turns for it yet.`,
        level: "warning",
      });
    } catch {}
    return { stop: () => {}, done: Promise.resolve(threadId || null) };
  }
}

/** Adapters for every long-tail dialect that has sessions on this machine. */
export function canonicalAdapters() {
  return DIALECTS.map((d) => new CanonicalAdapter(d)).filter((a) => {
    try {
      return a.hasSessions();
    } catch {
      return false;
    }
  });
}

export { CanonicalAdapter, DIALECTS, eventsFor, metaFor, walk };
