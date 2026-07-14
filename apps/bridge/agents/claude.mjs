/**
 * Claude Code adapter — reads sessions straight from ~/.claude/projects and
 * drives turns via `claude -p --output-format stream-json`. Replaces the
 * legacy daemon path for the claude agent.
 *
 * Transcript layout (~/.claude/projects/<escaped-cwd>/<sessionId>.jsonl), one
 * JSON record per line; every record carries sessionId/cwd/timestamp. Types:
 * user / assistant (content blocks text|thinking|tool_use) / system, with tool
 * results arriving as user records holding tool_result blocks; plus noise
 * (mode, attachment, file-history-snapshot, summary, isMeta wrappers).
 */
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { parseUserMessage, stripNoise } from "@litter/transcript";
import { SessionIndex } from "./session-index.mjs";
import {
  userMessage, thinking, assistantMessage, toolCall, toolResult, systemEvent,
  readTailLines, patchFromStructured, contentText,
} from "./events.mjs";
import { agentEnv, binVersion, binPath, liveAgentCwds } from "./env.mjs";

const ROOT = path.join(os.homedir(), ".claude", "projects");
// Claude Code's permission-mode names → the app's canonical PermissionMode.
const CLAUDE_MODE = {
  normal: "default", default: "default",
  auto: "acceptEdits", acceptEdits: "acceptEdits",
  plan: "plan", bypassPermissions: "bypassPermissions",
};
// A turn started outside the bridge shows as "running" while its file is this fresh.
const RUNNING_WINDOW_MS = 120_000;
// With a live agent process confirmed in the thread's cwd, a quiet mid-turn
// transcript stays "running" this long (covers long tool calls/builds).
const LIVE_EXTENDED_WINDOW_MS = 2 * 60 * 60_000;
const TURN_TIMEOUT_MS = Number(process.env.BRIDGE_TURN_TIMEOUT_MS || 300_000);
// Hard ceiling on one cached history's retained size; oldest turns are dropped.
const MAX_HISTORY_BYTES = 8 * 1024 * 1024;
// Cap a single streamed item's accumulated text (matches the old acc cap intent).
const MAX_STREAM_ITEM_BYTES = 2 * 1024 * 1024;

/** Preview/title text for a raw first user message (mirrors server cleanPreview). */
function cleanPreview(raw) {
  if (!raw) return null;
  const p = parseUserMessage(raw, "claude");
  const text =
    p.text ||
    (p.command ? `${p.command.name}${p.command.args ? ` ${p.command.args}` : ""}` : "") ||
    p.output?.text ||
    "";
  return text.trim() || null;
}

/** Lightweight refs for a user record's inline base64 image blocks. The ref
 *  `<uuid>:<blockIndex>` locates the block again in getImage (no data copied). */
function imageRefs(content, uuid) {
  const out = [];
  if (!Array.isArray(content)) return out;
  content.forEach((b, i) => {
    if (b?.type === "image" && b.source?.type === "base64" && b.source.data) {
      out.push({ mediaType: b.source.media_type || "image/png", ref: `${uuid}:${i}` });
    }
  });
  return out;
}

/** Is this user record an actual human message (not meta, not a tool result)? */
function isRealUserLine(o) {
  if (o.type !== "user" || o.isMeta || o.isSidechain) return false;
  const c = o.message?.content;
  if (typeof c === "string") return !!c.trim();
  if (Array.isArray(c)) return c.some((b) => b?.type === "text" && b.text?.trim());
  return false;
}

export class ClaudeAdapter {
  constructor({ turns }) {
    this.id = "claude";
    this.displayName = "Claude Code";
    this.description = "Anthropic's Claude Code CLI";
    this.capabilities = { streaming: true, tools: true, images: true, thinking: true, terminal: true, git: true };
    this.turns = turns;
    this.index = new SessionIndex({
      root: ROOT,
      match: (name) => name.endsWith(".jsonl"),
      scanFile: (file, st) => scanTranscript(file, st),
    });
  }

  onDirty(cb) { this.index.onDirty(cb); }

  async isAvailable() {
    return (await binVersion("claude")) != null;
  }

  async listThreads() {
    return this.index.list();
  }

  /** Locate a thread's transcript: index first, then a directory sweep (a file
   *  created moments ago may beat the watcher). */
  async findFile(threadId) {
    const meta = await this.index.get(threadId);
    if (meta?.filePath && existsSync(meta.filePath)) return meta.filePath;
    let dirs;
    try { dirs = readdirSync(ROOT); } catch { return null; }
    for (const d of dirs) {
      const p = path.join(ROOT, d, `${threadId}.jsonl`);
      if (existsSync(p)) return p;
    }
    return null;
  }

  /**
   * Full (or last-`limit`-turns) history as app timeline events. One readline
   * pass; turns are bucketed so `limit` trimming and the byte cap drop whole
   * oldest turns instead of splitting one.
   */
  async getEvents(threadId, { limit } = {}) {
    const file = await this.findFile(threadId);
    if (!file) return [];
    const turns = []; // array of { events: [], bytes }
    let cur = null;
    let totalBytes = 0;
    let truncated = false;
    const bucket = (startsTurn) => {
      if (startsTurn || !cur) { cur = { events: [], bytes: 0 }; turns.push(cur); }
      return cur;
    };
    const add = (ev, startsTurn = false) => {
      const b = bucket(startsTurn);
      const size = (ev.text?.length || 0) * 2 + (ev.result?.content?.text?.length || 0) * 2 +
        (ev.result?.content?.patch?.length || 0) * 2 + 200;
      b.events.push(ev);
      b.bytes += size;
      totalBytes += size;
      while ((limit && turns.length > limit) || (totalBytes > MAX_HISTORY_BYTES && turns.length > 1)) {
        const dropped = turns.shift();
        totalBytes -= dropped.bytes;
        truncated = true;
      }
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
      const base = (id) => ({ id, conversationId: threadId, seq: 0, ts });

      if (o.type === "user") {
        if (o.isMeta || o.isSidechain) continue;
        const c = o.message?.content;
        if (typeof c === "string") {
          const text = stripNoise(c, "claude");
          if (text.trim()) add(userMessage(base(o.uuid || `u:${ts}`), text), true);
          continue;
        }
        if (!Array.isArray(c)) continue;
        const uuid = o.uuid || `u:${ts}`;
        // Attached images are inline base64 blocks (~0.5MB each) — too heavy to
        // ship in the events list, so attach lightweight refs the client fetches
        // lazily from /v1/image, and drop the "[Image #N]" placeholder text.
        const imgs = imageRefs(c, uuid);
        const text = contentText(c);
        const cleaned = stripNoise(text, "claude").replace(/\[Image #\d+\]/g, "").trim();
        if (cleaned || imgs.length) add(userMessage(base(uuid), cleaned, imgs), true);
        for (const b of c) {
          if (b?.type !== "tool_result") continue;
          const callId = b.tool_use_id || o.uuid;
          const sp = o.toolUseResult?.structuredPatch;
          const content = sp?.length
            ? { kind: "diff", path: o.toolUseResult.filePath || "", patch: patchFromStructured(sp, o.toolUseResult.filePath) }
            : { kind: "text", text: contentText(b.content) || (typeof b.content === "string" ? b.content : "") };
          add(toolResult(base(`${callId}:o`), { toolCallId: callId, content, isError: !!b.is_error }));
        }
        continue;
      }

      if (o.type === "assistant") {
        const blocks = o.message?.content;
        if (!Array.isArray(blocks)) continue;
        blocks.forEach((b, i) => {
          const id = i === 0 ? (o.uuid || o.message?.id || `a:${ts}`) : `${o.uuid || o.message?.id}:${i}`;
          if (b.type === "thinking" && b.thinking?.trim()) add(thinking(base(id), b.thinking));
          else if (b.type === "text" && b.text?.trim()) add(assistantMessage(base(id), b.text));
          else if (b.type === "tool_use") add(toolCall(base(b.id || id), shellify(b.name, b.input)));
        });
      }
      if (o.type === "system") {
        // Newer CLIs write slash commands as system/local_command records and
        // compaction as system/compact_boundary — both visible in Claude
        // Code's own UI, so mirror them. High-volume subtypes
        // (stop_hook_summary, turn_duration, away_summary, …) stay hidden.
        if (o.subtype === "local_command" && typeof o.content === "string") {
          const text = stripNoise(o.content, "claude");
          if (text.trim()) add(userMessage(base(o.uuid || `c:${ts}`), text), true);
        } else if (o.subtype === "compact_boundary") {
          const m = o.compactMetadata || {};
          const k = (n) => (typeof n === "number" ? (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)) : null);
          const span = k(m.preTokens) && k(m.postTokens) ? ` (${k(m.preTokens)} → ${k(m.postTokens)} tokens)` : "";
          add(systemEvent(base(o.uuid || `cb:${ts}`), `Conversation compacted${span}`, "info"), true);
        }
        continue;
      }
      // mode / attachment / file-history-snapshot / summary: skipped —
      // the old daemon path surfaced none of these in history either.
    }

    const events = turns.flatMap((t) => t.events);
    events.forEach((ev, i) => { ev.seq = i + 1; });
    if (truncated && !limit) {
      events.unshift(systemEvent(
        { id: `${threadId}:trunc`, conversationId: threadId, seq: 0, ts: events[0]?.ts || new Date().toISOString() },
        "Older history truncated (thread too large to load fully)", "warning",
      ));
    }
    return events;
  }

  /** Decode one image block's bytes on demand — the ref (`<uuid>:<index>`)
   *  points at an inline base64 block getEvents chose not to inline. Scans the
   *  transcript for the record (a cheap substring prefilter skips the JSON.parse
   *  on unrelated lines of a huge file). */
  async getImage(threadId, ref) {
    const s = String(ref);
    const sep = s.lastIndexOf(":");
    if (sep < 0) return null;
    const uuid = s.slice(0, sep);
    const idx = Number(s.slice(sep + 1));
    const file = await this.findFile(threadId);
    if (!file || !Number.isInteger(idx)) return null;
    let rl;
    try { rl = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity }); }
    catch { return null; }
    try {
      for await (const line of rl) {
        if (!line || !line.includes(uuid)) continue;
        let o; try { o = JSON.parse(line); } catch { continue; }
        if (o.uuid !== uuid) continue;
        const c = o.message?.content;
        const b = Array.isArray(c) ? c[idx] : null;
        if (b?.type === "image" && b.source?.data) {
          return { mediaType: b.source.media_type || "image/png", buffer: Buffer.from(b.source.data, "base64") };
        }
        return null;
      }
    } finally { rl.close(); }
    return null;
  }

  /** Cheap activity probe: live child wins; otherwise judge the transcript
   *  tail, sharpened by process liveness — a live claude in the thread's cwd
   *  keeps a quiet mid-turn "running" (long builds), and its absence demotes a
   *  killed turn immediately instead of after the mtime window. */
  async getActivity(threadId) {
    if (this.turns.isRunning("claude", threadId)) {
      return { activity: "running", lastActivityAt: new Date().toISOString() };
    }
    const cwd = this.index.metas.get(threadId)?.cwd;
    const [file, live] = await Promise.all([
      this.findFile(threadId),
      cwd ? liveAgentCwds() : null,
    ]);
    // null = liveness unknown → the mtime heuristic decides
    const liveInCwd = cwd && live ? (live.get("claude")?.has(cwd) ?? false) : null;
    return judgeTranscript(file, liveInCwd);
  }

  listModels() {
    // The claude CLI resolves aliases/full ids itself; a static list keeps the
    // picker useful without a daemon to ask. Default mirrors the CLI default.
    return [
      { id: "claude-opus-4-8", name: "Opus 4.8", description: "Most capable, default", isDefault: true, deprecated: false },
      { id: "claude-fable-5", name: "Fable 5", description: "Claude 5 frontier model", isDefault: false, deprecated: false },
      { id: "claude-sonnet-5", name: "Sonnet 5", description: "Fast and capable", isDefault: false, deprecated: false },
      { id: "claude-haiku-4-5", name: "Haiku 4.5", description: "Fastest", isDefault: false, deprecated: false },
    ];
  }

  /**
   * Run one turn headlessly. Fresh threads pre-generate the session id
   * (--session-id) so the real thread id is known before the first byte.
   * Input goes over stdin as one stream-json user message (works for plain
   * text and base64 images alike, and dodges argv size/quoting limits).
   */
  async startTurn({ threadId, text, cwd, images, permissionMode, reasoningEffort, model }, onEvent) {
    this.turns.assertCapacity();
    const fresh = !threadId || !/^[0-9a-f]{8}-/i.test(threadId);
    const sessionId = fresh ? randomUUID() : threadId;

    if (!fresh) {
      if (this.turns.isRunning("claude", threadId)) {
        return failedTurn(sessionId, "A turn is already running for this thread — interrupt it first.", onEvent);
      }
      // Resuming a session that's mid-turn in ANOTHER process (a terminal /
      // FleetView session) forks a live agent that keeps working the original
      // task with full permissions — observed forking a session that then
      // killed this very bridge. Refuse while the transcript tail shows an
      // in-flight turn; the user can retry once it settles.
      const act = await this.getActivity(threadId).catch(() => null);
      if (act?.activity === "running") {
        return failedTurn(sessionId,
          "This thread is currently active in another Claude Code session on the host — wait for it to finish, then retry.",
          onEvent);
      }
    }

    const args = ["-p", "--verbose", "--output-format", "stream-json",
      "--include-partial-messages", "--input-format", "stream-json"];
    args.push(fresh ? "--session-id" : "--resume", sessionId);
    // The daemon ran with bypass_permissions=true (host.toml) — headless turns
    // can't answer permission prompts, so "default" maps to bypass to keep the
    // phone UX working. Explicit non-default modes pass through verbatim.
    const mode = permissionMode && permissionMode !== "default" ? permissionMode : "bypassPermissions";
    args.push("--permission-mode", mode);
    if (model) args.push("--model", model);
    const effort = { minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "high" }[reasoningEffort];
    if (effort) args.push("--effort", effort);

    // Transcripts are keyed by project dir, so a resume MUST run from the
    // thread's own cwd — from anywhere else claude reports "no conversation
    // found". Prefer the caller's cwd, fall back to the indexed one, and fail
    // loudly when the workspace is gone (archived/cleaned worktree) instead of
    // silently resuming from $HOME.
    let dir = cwd && existsSync(cwd) ? cwd : null;
    if (!dir && !fresh) {
      const meta = this.index.metas.get(threadId);
      if (meta?.cwd && existsSync(meta.cwd)) dir = meta.cwd;
      if (!dir) {
        return failedTurn(sessionId,
          `This thread's folder no longer exists (${cwd || meta?.cwd || "unknown"}) — it can't be resumed. Start a new conversation instead.`,
          onEvent);
      }
    }
    if (!dir) dir = os.homedir();
    let child;
    try {
      child = spawn(binPath("claude"), args, { cwd: dir, env: agentEnv(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (e) {
      return failedTurn(sessionId, String(e?.message || e), onEvent);
    }
    const entry = this.turns.register("claude", [sessionId, threadId], child);

    const content = [{ type: "text", text }];
    for (const img of images || []) {
      if (img?.data) content.push({ type: "image", source: { type: "base64", media_type: img.mediaType || "image/png", data: img.data } });
    }
    try {
      child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n");
      child.stdin.end();
    } catch {}

    let seq = 0;
    let sawReply = false; // any assistant/tool event reached the client
    const now = () => new Date().toISOString();
    const base = (id) => ({ id, conversationId: sessionId, seq: ++seq, ts: now() });
    const emit = (ev) => {
      if (ev.type !== "user_message" && ev.type !== "system_event") sawReply = true;
      try { onEvent(ev); } catch {}
    };

    // The daemon echoed the user's message as a stream item; mirror that.
    emit(userMessage(base(`${sessionId}:input`), text));

    let stderrTail = "";
    child.stderr.on("data", (d) => {
      stderrTail = (stderrTail + d).slice(-8192);
    });

    let msgN = 0;
    const acc = new Map(); // stream block id -> accumulated text
    // Streamed block ids don't line up with the final `assistant` records'
    // content indexes (finals arrive one-block-per-record), so track open
    // streamed blocks FIFO per kind and let each final consume one — the final
    // message then replaces its own streaming bubble instead of duplicating it.
    const open = { text: [], thinking: [] };
    let sawResult = false;
    let resolveDone, rejectDone;
    const done = new Promise((res, rej) => { resolveDone = res; rejectDone = rej; });
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      acc.clear();
      this.turns.release(entry);
      // Resuming a session that's LIVE in another window (terminal/FleetView)
      // doesn't run an independent turn — claude delivers the message into the
      // running session and returns without a reply, and the child can linger.
      // Tell the phone what happened instead of ending in silence…
      if (!err && !sawReply) {
        emit(systemEvent(base(`${sessionId}:live`),
          "No reply here — this thread appears active in another window; your message was delivered to that session.",
          "warning"));
      }
      // …and never leak the child: if it survives the result, reap it.
      setTimeout(() => {
        if (child.exitCode === null) {
          console.log(`[turn] claude lingering child pid=${child.pid} thread=${sessionId} — reaping`);
          try { child.kill("SIGKILL"); } catch {}
        }
      }, 5000).unref?.();
      if (err) rejectDone(err); else resolveDone(sessionId);
    };

    const handle = (o) => {
      if (o.type === "system" && o.subtype === "init") {
        if (o.session_id) this.turns.alias(entry, "claude", o.session_id);
        return;
      }
      if (o.type === "stream_event") {
        const ev = o.event || {};
        if (ev.type === "message_start") { msgN++; return; }
        if (ev.type === "content_block_delta") {
          const key = `${sessionId}:${msgN}:${ev.index}`;
          const d = ev.delta || {};
          const piece = d.type === "text_delta" ? d.text : d.type === "thinking_delta" ? d.thinking : null;
          if (typeof piece !== "string") return;
          if (!acc.has(key)) (d.type === "thinking_delta" ? open.thinking : open.text).push(key);
          const text = ((acc.get(key) || "") + piece).slice(0, MAX_STREAM_ITEM_BYTES);
          acc.set(key, text);
          if (d.type === "thinking_delta") emit(thinking(base(key), text));
          else emit(assistantMessage(base(key), text, true));
        }
        return;
      }
      if (o.type === "assistant") {
        const blocks = o.message?.content || [];
        blocks.forEach((b, i) => {
          if (b.type === "text") {
            const key = open.text.shift() || `${sessionId}:${msgN}:f${i}`;
            acc.delete(key); // block finalized — free the streamed accumulator
            if (b.text?.trim()) emit(assistantMessage(base(key), b.text, false));
          } else if (b.type === "thinking") {
            const key = open.thinking.shift() || `${sessionId}:${msgN}:f${i}`;
            acc.delete(key);
            if (b.thinking?.trim()) emit(thinking(base(key), b.thinking));
          } else if (b.type === "tool_use") {
            emit(toolCall(base(b.id || `${sessionId}:${msgN}:f${i}`), shellify(b.name, b.input)));
          }
        });
        return;
      }
      if (o.type === "user") {
        for (const b of o.message?.content || []) {
          if (b?.type !== "tool_result") continue;
          const callId = b.tool_use_id;
          emit(toolResult(base(`${callId}:o`), {
            toolCallId: callId,
            content: { kind: "text", text: contentText(b.content) || (typeof b.content === "string" ? b.content : "") },
            isError: !!b.is_error,
          }));
        }
        return;
      }
      if (o.type === "result") {
        // Resuming a session with queued task notifications drains each as a
        // zero-turn exchange (result/success, num_turns:0, empty result) BEFORE
        // the real turn runs. Those are not the end of OUR turn — skipping them
        // is the difference between the phone seeing the reply and a silent 1s
        // no-op (the original "step 3 didn't work" bug).
        if (!o.is_error && o.subtype === "success" && o.num_turns === 0) return;
        sawResult = true;
        // Surface any non-success outcome — "no conversation found", API
        // errors, execution errors — or the app just sees a silent no-op.
        if (o.is_error || (o.subtype && o.subtype !== "success")) {
          emit(systemEvent(base(`${sessionId}:err`), String(o.result || o.subtype || "turn failed"), "error"));
        }
        finish();
      }
    };

    const t0 = Date.now();
    console.log(`[turn] claude ${fresh ? "start" : "resume"} thread=${sessionId} cwd=${dir}`);

    // Idle timeout, not absolute: a huge thread's resume replays its whole
    // context, so time-to-first-token alone can take minutes — kill only when
    // the CLI has produced nothing at all for the window. Any stdout resets it.
    let timer;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        console.log(`[turn] claude idle>${TURN_TIMEOUT_MS / 1000}s thread=${sessionId} — killing`);
        try { child.kill("SIGKILL"); } catch {}
      }, TURN_TIMEOUT_MS);
    };
    arm();

    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      arm();
      if (line) { try { handle(JSON.parse(line)); } catch {} }
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      console.log(`[turn] claude exit code=${code} thread=${sessionId} in ${Math.round((Date.now() - t0) / 1000)}s ${sawResult ? "(result)" : "(no result)"}${code !== 0 ? ` stderr: ${stderrTail.trim().slice(-300)}` : ""}`);
      if (!sawResult && code !== 0 && !settled) {
        emit(systemEvent(base(`${sessionId}:err`), `claude exited (${code}): ${stderrTail.trim().slice(-500)}`, "error"));
      }
      finish();
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      emit(systemEvent(base(`${sessionId}:err`), `claude failed to start: ${e?.message || e}`, "error"));
      finish();
    });

    return { stop: () => this.turns.interrupt("claude", sessionId), done };
  }
}

/**
 * Judge a transcript's activity from its mtime + a 64KB tail read (sync, cheap).
 *
 * `liveInCwd` (tri-state) refines the mid-turn verdict with process liveness:
 *   true  → an agent process is alive in this thread's cwd, so a mid-turn tail
 *           stays "running" even when a long tool call writes nothing for a
 *           while — capped at 2h so an abandoned mid-turn transcript can't ride
 *           a *different* session sharing the cwd forever;
 *   false → no process, so a killed turn demotes to "completed" immediately;
 *   null  → liveness unknown, fall back to the pure mtime window.
 */
function judgeTranscript(file, liveInCwd = null) {
  if (!file) return { activity: "idle", lastActivityAt: null };
  let mtimeMs;
  try { mtimeMs = statSync(file).mtimeMs; } catch { return { activity: "idle", lastActivityAt: null }; }
  const lastActivityAt = new Date(mtimeMs).toISOString();
  const sinceWrite = Date.now() - mtimeMs;
  const windowMs = liveInCwd ? LIVE_EXTENDED_WINDOW_MS : RUNNING_WINDOW_MS;
  const recent = liveInCwd !== false && sinceWrite < windowMs;

  // Walk the tail backwards to the last meaningful record.
  const lines = readTailLines(file);
  for (let i = lines.length - 1; i >= 0; i--) {
    let o;
    try { o = JSON.parse(lines[i]); } catch { continue; }
    if (o.type === "assistant") {
      const blocks = o.message?.content || [];
      const lastBlock = Array.isArray(blocks) ? blocks[blocks.length - 1] : null;
      // Ends on tool_use → a tool is (was) executing; text → the agent finished.
      if (lastBlock?.type === "tool_use") return { activity: recent ? "running" : "completed", lastActivityAt };
      return { activity: "completed", lastActivityAt };
    }
    if (o.type === "user") {
      if (o.isMeta) continue;
      // Tool result or a fresh user prompt with no reply yet → mid-turn.
      return { activity: recent ? "running" : "completed", lastActivityAt };
    }
    if (o.type === "system" && o.level === "error") return { activity: "failed", lastActivityAt };
  }
  return { activity: "idle", lastActivityAt };
}

/** The daemon surfaced shell commands as name:"shell" with {command}; match it. */
function shellify(name, input) {
  if (name === "Bash" && input && typeof input.command === "string") {
    return { name: "shell", input: { command: input.command }, status: "success" };
  }
  return { name: name || "tool", input: input ?? {}, status: "success" };
}

/** A turn that never got a child: emit the reason, resolve immediately. */
function failedTurn(threadId, message, onEvent, level = "error") {
  try {
    onEvent({
      id: `${threadId}:spawn-err`, conversationId: threadId, seq: 1,
      ts: new Date().toISOString(), type: "system_event", message, level,
    });
  } catch {}
  return { stop: () => {}, done: Promise.resolve(threadId) };
}

/**
 * Bounded head-scan of one transcript → thread meta. Streams and aborts after
 * the essentials (cwd + preview) or a hard line/byte budget, so 300 files cost
 * a few MB of transient I/O at boot and nothing retained beyond ~300 bytes each.
 */
function scanTranscript(file, st) {
  return new Promise((resolve) => {
    const id = path.basename(file, ".jsonl");
    let cwd = null, createdAt = null, gitBranch = null, name = null;
    let preview = null;         // first real prose message — what a human titles it
    let previewFallback = null; // first slash-command chip, if that's all there is
    let sawUserLine = false;
    let lines = 0, bytes = 0;
    const stream = createReadStream(file, "utf8");
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    const settle = () => {
      rl.close();
      stream.destroy();
      // Sessions with no real user message (warmups, snapshots-only) are noise.
      if (!sawUserLine) return resolve(null);
      // Both the freshest AI title and the CURRENT permission mode live mid/
      // late-file (past this head scan) — one cheap 64KB tail read (latest-first)
      // recovers each. `permission-mode` records and every `user` record carry
      // `permissionMode` (normal/auto/plan/bypassPermissions); the newest wins.
      let permissionMode = null;
      for (const line of readTailLines(file).reverse()) {
        if (!name && line.includes('"ai-title"')) {
          try {
            const o = JSON.parse(line);
            if (o.type === "ai-title" && o.aiTitle) name = String(o.aiTitle).slice(0, 200);
          } catch {}
        }
        if (!permissionMode && line.includes("permissionMode")) {
          try {
            const o = JSON.parse(line);
            if (typeof o.permissionMode === "string") permissionMode = CLAUDE_MODE[o.permissionMode] || null;
          } catch {}
        }
        if (name && permissionMode) break;
      }
      resolve({
        id, filePath: file, cwd, name, preview: preview || previewFallback,
        createdAt, updatedAt: new Date(st.mtimeMs).toISOString(),
        gitBranch, sizeBytes: st.size, permissionMode,
      });
    };
    rl.on("line", (line) => {
      lines++; bytes += line.length;
      if (line) {
        try {
          const o = JSON.parse(line);
          if (!cwd && o.cwd) cwd = o.cwd;
          if (!createdAt && o.timestamp) createdAt = o.timestamp;
          if (!gitBranch && o.gitBranch) gitBranch = o.gitBranch;
          if (!name && o.type === "summary" && o.summary) name = String(o.summary).slice(0, 200);
          if (!name && o.type === "ai-title" && o.aiTitle) name = String(o.aiTitle).slice(0, 200);
          if (!preview && isRealUserLine(o)) {
            sawUserLine = true;
            const raw = typeof o.message.content === "string" ? o.message.content : contentText(o.message.content);
            const p = parseUserMessage(raw, "claude");
            // A session often opens with slash commands (/clear, /model) before
            // the real ask — keep scanning for prose and only fall back to the
            // command chip when the whole head is commands.
            if (p.text?.trim()) preview = p.text.trim().slice(0, 200);
            else if (!previewFallback) previewFallback = cleanPreview(raw)?.slice(0, 200) || null;
          }
        } catch {}
      }
      if ((cwd && preview) || lines > 80 || bytes > 512 * 1024) settle();
    });
    rl.on("close", settle);
    stream.on("error", settle);
  });
}
