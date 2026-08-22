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
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { parseUserMessage, stripNoise } from "@pounce/transcript";
import { SessionIndex } from "./session-index.mjs";
import {
  userMessage,
  thinking,
  assistantMessage,
  toolCall,
  toolResult,
  systemEvent,
  readTailLines,
  patchFromStructured,
  contentText,
  clampMarkdown,
} from "./events.mjs";
import { agentEnv, binVersion, binPath, liveAgentCwds } from "./env.mjs";
import { recordTurn, threadTotals } from "./cost-ledger.mjs";
import { normalizeCliCommands, rememberCommands } from "./commands.mjs";
import { noUsage, usageResult } from "./usage.mjs";

const CLAUDE_HOME = path.join(os.homedir(), ".claude");
const ROOT = path.join(CLAUDE_HOME, "projects");
// Claude Code's permission-mode names → the app's canonical PermissionMode.
const CLAUDE_MODE = {
  normal: "default",
  default: "default",
  auto: "acceptEdits",
  acceptEdits: "acceptEdits",
  plan: "plan",
  bypassPermissions: "bypassPermissions",
};
// A turn started outside the bridge shows as "running" while its file is this fresh.
const RUNNING_WINDOW_MS = 120_000;
// A transcript touched inside this window is treated as still being written.
// Sized to cover the pause between an agent's prose and its next tool call.
const FOREIGN_WRITE_WINDOW_MS = 90_000;
// With a live agent process confirmed in the thread's cwd, a quiet mid-turn
// transcript stays "running" this long (covers long tool calls/builds).
const LIVE_EXTENDED_WINDOW_MS = 2 * 60 * 60_000;
// How long a turn waits for a session another process is driving (see
// awaitForeignTurn), and how often it re-checks. The cap is generous because
// the alternative is losing the message: a build or a long tool call routinely
// holds a thread for minutes, and the wait costs an idle poll, not a process.
const FOREIGN_WAIT_MS = Number(process.env.BRIDGE_FOREIGN_WAIT_MS || 15 * 60_000);
const FOREIGN_POLL_MS = 3_000;
const TURN_TIMEOUT_MS = Number(process.env.BRIDGE_TURN_TIMEOUT_MS || 300_000);
// Hard ceiling on one cached history's retained size; oldest turns are dropped.
const MAX_HISTORY_BYTES = 8 * 1024 * 1024;
// Cap a single streamed item's accumulated text (matches the old acc cap intent).
const MAX_STREAM_ITEM_BYTES = 2 * 1024 * 1024;
// Compaction summaries run long; keep the folded copy readable, not verbatim.
const MAX_COMPACT_DETAIL = 8 * 1024;

// Claude Code keeps its settings in ~/.claude/settings.json (the directory)
// and the rest of its client state in ~/.claude.json (the file). Both are read.
const CLAUDE_SETTINGS = path.join(CLAUDE_HOME, "settings.json");
const CLAUDE_CLIENT_STATE = path.join(os.homedir(), ".claude.json");
// Newest transcripts scanned for model ids, and how much of each tail is read.
// The tail is where the model lands: it is on every assistant record, and the
// last one is the model the thread most recently ran on.
const MODEL_SCAN_FILES = 40;
const MODEL_SCAN_TAIL_BYTES = 32 * 1024;
// ...and how far back that scan is allowed to reach. A machine that ran forty
// threads last year would otherwise keep resurrecting the models they ended on,
// which is exactly how superseded ids stayed in the picker. Past this, a model
// is something this machine USED to run; the aliases still cover you.
const MODEL_SCAN_MAX_AGE_MS = 30 * 24 * 60 * 60_000;

/** Family aliases the CLI resolves to the CURRENT model in each family
 *  ("Provide an alias for the latest model … or a model's full name").
 *  These are the only ids named here, precisely because an alias cannot rot. */
const MODEL_ALIASES = [
  { id: "opus", name: "Opus (latest)", description: "Most capable" },
  { id: "fable", name: "Fable (latest)", description: "Frontier model" },
  { id: "sonnet", name: "Sonnet (latest)", description: "Fast and capable" },
  { id: "haiku", name: "Haiku (latest)", description: "Fastest" },
];

/** Parsed JSON from a config file, or null — an absent or half-written file is
 *  an ordinary state here, never an error. */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** "claude-opus-5" → "Opus 5"; "claude-haiku-4-5-20251001" → "Haiku 4.5";
 *  "claude-fable-5[1m]" → "Fable 5 [1m]". Mirrors the app's shortModel(). */
function prettyModel(id) {
  return id
    .replace(/^claude-/, "")
    .replace(/-\d{8}(?=\[|$)/, "")
    .replace(/-(\d+)-(\d+)(?=\[|$)/, " $1.$2")
    .replace(/-(\d+)(?=\[|$)/, " $1")
    .replace(/\b[a-z]/, (c) => c.toUpperCase());
}

/**
 * `{ family, version }` for a versioned model id, or null for one that names no
 * version — the aliases, which mean "latest" and so can never be superseded.
 *
 * Nothing here names a family or a version: the family is just the id's first
 * word-shaped token, so a family that ships tomorrow parses like the ones that
 * shipped yesterday. Two deliberate details:
 *   - the context variant is part of the family key, because `claude-fable-5[1m]`
 *     and `claude-fable-5` are different products and neither retires the other;
 *   - the 8-digit snapshot date is dropped, so `haiku-4-5-20251001` and
 *     `haiku-4-5` compare equal instead of one appearing to supersede the other.
 */
function modelVersion(id) {
  const lower = String(id).toLowerCase();
  const variant = /\[([^\]]*)\]/.exec(lower)?.[1] ?? "";
  const parts = lower
    .replace(/\[[^\]]*\]/, "")
    .split("-")
    .filter(Boolean);
  const family = parts.find((p) => p !== "claude" && !/^\d+$/.test(p));
  // Legacy ids put the version first ("claude-3-5-sonnet-…"); order doesn't
  // matter here, only which tokens are numbers and which is the family word.
  const version = parts.filter((p) => /^\d+$/.test(p) && p.length !== 8).map(Number);
  if (!family || !version.length) return null;
  return { family: variant ? `${family}[${variant}]` : family, version };
}

/** Compare dotted versions: [4,8] < [5], [4,5] == [4,5]. */
function cmpVersion(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Flag every model a newer sibling in its own family has superseded, in place.
 *
 * This is the "the picker still offers Opus 4.8" fix, and it is deliberately a
 * flag rather than a filter: a thread that ran on an older model has to be able
 * to go back to it, so the entry stays selectable — it just says what it is and
 * sorts below the current models. Detection is relative, never a pinned list:
 * whatever this machine can see is the newest of a family defines the rest.
 */
function markSuperseded(models) {
  const newest = new Map();
  for (const m of models) {
    const v = modelVersion(m.id);
    if (!v) continue;
    const cur = newest.get(v.family);
    if (!cur || cmpVersion(v.version, cur) > 0) newest.set(v.family, v.version);
  }
  for (const m of models) {
    const v = modelVersion(m.id);
    m.deprecated = !!v && cmpVersion(v.version, newest.get(v.family)) < 0;
  }
  return models;
}

/** The model Claude Code itself is configured to use, if any. */
function configuredModel() {
  for (const file of [CLAUDE_SETTINGS, CLAUDE_CLIENT_STATE]) {
    const m = readJson(file)?.model;
    if (typeof m === "string" && m.trim()) return m.trim();
  }
  return null;
}

/** Extra model options the CLI caches from the server — promos and long-context
 *  variants that no alias names. Carries the server's own label/description. */
function cachedModelOptions() {
  const list = readJson(CLAUDE_CLIENT_STATE)?.additionalModelOptionsCache;
  if (!Array.isArray(list)) return [];
  return list
    .filter((o) => o && typeof o.value === "string" && o.value)
    .map((o) => ({
      id: o.value,
      name: typeof o.label === "string" && o.label ? o.label : prettyModel(o.value),
      description: typeof o.description === "string" ? o.description : null,
    }));
}

/** Versioned model ids this machine has actually run, most recent first.
 *
 *  Read from the tail of the newest transcripts: `message.model` on an
 *  assistant record is what the API answered with, so every id here provably
 *  exists and this account can reach it. `<synthetic>` marks Claude Code's own
 *  locally-generated messages and is not a model. */
async function observedModels(index) {
  const seen = new Set();
  let metas = [];
  try {
    metas = await index.list();
  } catch {
    return [];
  }
  const cutoff = Date.now() - MODEL_SCAN_MAX_AGE_MS;
  for (const meta of metas.slice(0, MODEL_SCAN_FILES)) {
    if (!meta?.filePath) continue;
    // list() is newest-first, so the first thread past the window ends the scan.
    const touched = meta.updatedAt ? Date.parse(meta.updatedAt) : NaN;
    if (Number.isFinite(touched) && touched < cutoff) break;
    for (const line of readTailLines(meta.filePath, MODEL_SCAN_TAIL_BYTES).reverse()) {
      if (!line.includes('"model"')) continue;
      let id;
      try {
        id = JSON.parse(line)?.message?.model;
      } catch {
        continue;
      }
      if (typeof id === "string" && id && id !== "<synthetic>") {
        seen.add(id);
        break; // one per transcript: its newest model, in newest-thread order
      }
    }
  }
  return [...seen];
}

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

/**
 * Pull the official metrics out of a stream-json `result` envelope.
 *
 * Every number here is copied verbatim — we never price tokens ourselves. The
 * envelope looks like:
 *   { total_cost_usd, duration_ms, uuid, usage:{ input_tokens, … },
 *     modelUsage:{ "claude-opus-5[1m]": { costUSD, contextWindow, … } } }
 *
 * `modelUsage` keys are the exact model strings the CLI billed against
 * (including variant suffixes like `[1m]`), so we keep the busiest one rather
 * than the tidier `canonicalModel` — it's what actually ran.
 */
function turnMetrics(sessionId, o) {
  const u = o.usage || {};
  const mu = o.modelUsage && typeof o.modelUsage === "object" ? o.modelUsage : {};
  const byOutput = Object.entries(mu).sort(
    (a, b) => (b[1]?.outputTokens || 0) - (a[1]?.outputTokens || 0),
  );
  const [model, top] = byOutput[0] || [null, null];
  return {
    agent: "claude",
    threadId: o.session_id || sessionId,
    turnId: o.uuid || null,
    model,
    costUsd: typeof o.total_cost_usd === "number" ? o.total_cost_usd : null,
    contextWindow: top?.contextWindow ?? null,
    durationMs: o.duration_ms ?? null,
    tokens: {
      input: u.input_tokens || 0,
      output: u.output_tokens || 0,
      cacheRead: u.cache_read_input_tokens || 0,
      cacheCreation: u.cache_creation_input_tokens || 0,
    },
    source: "claude-result",
  };
}

/**
 * A user record that is nothing but a bare slash command, e.g. "/compact".
 *
 * Claude Code records such an invocation TWICE: once as the raw typed line and
 * again as a `<command-name>…</command-name>` envelope, which is the one that
 * renders as a command chip. Showing both put a plain "/compact" prose bubble
 * above the chip. Across the local corpus every bare record was `/compact` (13
 * of them; no other command double-records) and 10 were followed by their
 * envelope 9-50 records later — too variable to pair positionally, so drop the
 * bare line and let the envelope stand. For the 3 with no envelope the
 * compact_boundary note still marks that a compaction happened.
 */
function isBareSlashCommand(text) {
  return /^\/[\w:-]+$/.test(text.trim());
}

/**
 * Records the CLI writes as `type:"user"` purely to re-seed the model's context
 * — the post-compaction summary is the only one so far. Claude Code flags them
 * `isVisibleInTranscriptOnly` and keeps them out of its own chat view; without
 * this check they render as a giant purple user bubble nobody typed.
 */
function isTranscriptOnly(o) {
  return !!(o.isVisibleInTranscriptOnly || o.isCompactSummary);
}

/**
 * Cut `text` to at most `max` chars on a line boundary. The client renders this
 * as markdown, so a mid-token slice leaves a dangling `**` or an unclosed fence
 * and the tail renders as literal punctuation. Closes an odd code fence too.
 */
/** Is this user record an actual human message (not meta, not a tool result)? */
function isRealUserLine(o) {
  if (o.type !== "user" || o.isMeta || o.isSidechain || isTranscriptOnly(o)) return false;
  const c = o.message?.content;
  // A bare "/compact" is not the thread's subject — keep scanning for prose.
  if (typeof c === "string") return !!c.trim() && !isBareSlashCommand(c);
  if (Array.isArray(c)) return c.some((b) => b?.type === "text" && b.text?.trim());
  return false;
}

export class ClaudeAdapter {
  constructor({ turns }) {
    // threadId -> when a turn WE ran last wrote it, so our own writes are not
    // mistaken for another process (see isForeignWriter).
    this.ownWrites = new Map();
    this.id = "claude";
    this.displayName = "Claude Code";
    this.description = "Anthropic's Claude Code CLI";
    this.capabilities = {
      streaming: true,
      tools: true,
      images: true,
      thinking: true,
      terminal: true,
      git: true,
    };
    this.turns = turns;
    this.index = new SessionIndex({
      root: ROOT,
      match: (name) => name.endsWith(".jsonl"),
      scanFile: (file, st) => scanTranscript(file, st),
      cacheName: "claude",
    });
  }

  onDirty(cb) {
    this.index.onDirty(cb);
  }

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
    try {
      dirs = readdirSync(ROOT);
    } catch {
      return null;
    }
    for (const d of dirs) {
      const p = path.join(ROOT, d, `${threadId}.jsonl`);
      if (existsSync(p)) return p;
    }
    return null;
  }

  /**
   * Token totals from the transcript, plus real USD for whatever slice of the
   * thread the bridge itself drove.
   *
   * Claude Code records `message.usage` on every assistant line but never a
   * dollar figure — `total_cost_usd` exists only on the live stream-json result
   * envelope, which we bank in the cost ledger as turns complete. So tokens
   * always cover the whole thread while cost covers only bridge-driven turns;
   * `costComplete: false` says so, and a thread taken entirely in a terminal
   * reports tokens with `cost: null` rather than a guess.
   */
  async getUsage(threadId) {
    const file = await this.findFile(threadId);
    if (!file) return noUsage("no-transcript");
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
    const outByModel = new Map();
    let lastModel = null;
    let lastModelAt = null;
    let messages = 0;
    let contextUsed = null;
    let rl;
    // Stream it: a multi-million-token thread's JSONL must never be slurped.
    try {
      rl = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
    } catch {
      return noUsage("no-transcript");
    }
    for await (const line of rl) {
      if (!line) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o.type !== "assistant") continue;
      const u = o.message?.usage;
      if (!u) continue;
      messages++;
      tokens.input += u.input_tokens || 0;
      tokens.output += u.output_tokens || 0;
      tokens.cacheRead += u.cache_read_input_tokens || 0;
      tokens.cacheCreation += u.cache_creation_input_tokens || 0;
      // "<synthetic>" is Claude Code's marker for locally-generated records
      // (API error text, interrupt notices) — not a model anyone ran, so it
      // must not show up in the thread's model list.
      const m = o.message?.model;
      if (m && m !== "<synthetic>") {
        outByModel.set(m, (outByModel.get(m) || 0) + (u.output_tokens || 0));
        // Records are in order, so the last one wins: this is what the thread is
        // running on NOW, which is a different question from `model` below (the
        // thread's dominant model) and the one that catches a mid-thread change.
        // Sidechains are subagents on their own model and don't move the thread.
        if (!o.isSidechain) {
          lastModel = m;
          lastModelAt = typeof o.timestamp === "string" ? o.timestamp : null;
        }
      }
      // Context fill = the prompt of the most recent real request. Sidechains
      // (Task-tool subagents) carry their own separate context, and synthetic
      // records aren't requests at all — either would understate the main
      // thread's fill if it happened to land last.
      if (!o.isSidechain && m !== "<synthetic>") {
        contextUsed =
          (u.input_tokens || 0) +
          (u.cache_read_input_tokens || 0) +
          (u.cache_creation_input_tokens || 0);
      }
    }
    if (!messages) return noUsage("no-usage");
    const ledger = await threadTotals("claude", threadId).catch(() => null);
    const models = [...outByModel.keys()];
    return usageResult({
      tokens,
      // Official only: whatever the CLI billed for turns we ran, or nothing.
      cost: ledger?.cost ?? null,
      // The ledger holds bridge-driven turns; the transcript holds all of them.
      // Equal output-token counts is the signal that we saw the whole thread.
      costComplete: !!ledger && ledger.costComplete && ledger.tokens.output >= tokens.output,
      costSource: ledger?.cost != null ? "agent" : null,
      model: models.slice().sort((a, b) => outByModel.get(b) - outByModel.get(a))[0] || null,
      models,
      lastModel,
      lastModelAt,
      messages,
      // Claude Code never writes the context window to its transcript — the
      // only official source is the live result envelope, so the window is
      // known once a turn has been taken from Pounce and not before.
      contextWindow: ledger?.contextWindow ?? null,
      contextUsed,
    });
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
      if (startsTurn || !cur) {
        cur = { events: [], bytes: 0 };
        turns.push(cur);
      }
      return cur;
    };
    /** Bill `size` to the newest turn and evict old ones until we're back in budget. */
    const charge = (b, size) => {
      b.bytes += size;
      totalBytes += size;
      while (
        (limit && turns.length > limit) ||
        (totalBytes > MAX_HISTORY_BYTES && turns.length > 1)
      ) {
        const dropped = turns.shift();
        totalBytes -= dropped.bytes;
        truncated = true;
      }
    };
    const add = (ev, startsTurn = false) => {
      const b = bucket(startsTurn);
      const size =
        (ev.text?.length || 0) * 2 +
        (ev.result?.content?.text?.length || 0) * 2 +
        (ev.result?.content?.patch?.length || 0) * 2 +
        200;
      b.events.push(ev);
      charge(b, size);
      return { ev, bucket: b };
    };

    let rl;
    try {
      rl = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
    } catch {
      return [];
    }
    // Set by a compact_boundary record and readable only by the record directly
    // after it — the summary the CLI always writes there.
    let pendingCompact = null;
    for await (const line of rl) {
      if (!line) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      const lastCompact = pendingCompact;
      pendingCompact = null;
      const ts = o.timestamp || new Date().toISOString();
      const base = (id) => ({ id, conversationId: threadId, seq: 0, ts });

      if (o.type === "user") {
        if (o.isMeta || o.isSidechain) continue;
        // The compaction summary is written as a user turn (that's how it gets
        // back into the model's context) but it isn't one. Fold it into the
        // "Conversation compacted" note the CLI wrote on the line just before,
        // so the carried-over context stays readable without a fake user bubble.
        if (isTranscriptOnly(o)) {
          if (o.isCompactSummary && lastCompact) {
            const body = stripNoise(contentText(o.message?.content), "claude")
              .replace(/^This session is being continued from[^]*?Summary:\s*/i, "")
              .trim();
            if (body) {
              lastCompact.ev.detail = clampMarkdown(body, MAX_COMPACT_DETAIL);
              charge(lastCompact.bucket, lastCompact.ev.detail.length * 2);
            }
          }
          continue;
        }
        const c = o.message?.content;
        if (typeof c === "string") {
          const text = stripNoise(c, "claude");
          if (text.trim() && !isBareSlashCommand(text))
            add(userMessage(base(o.uuid || `u:${ts}`), text), true);
          continue;
        }
        if (!Array.isArray(c)) continue;
        const uuid = o.uuid || `u:${ts}`;
        // Attached images are inline base64 blocks (~0.5MB each) — too heavy to
        // ship in the events list, so attach lightweight refs the client fetches
        // lazily from /v1/image, and drop the "[Image #N]" placeholder text.
        const imgs = imageRefs(c, uuid);
        const text = contentText(c);
        const cleaned = stripNoise(text, "claude")
          .replace(/\[Image #\d+\]/g, "")
          .trim();
        if (cleaned || imgs.length) add(userMessage(base(uuid), cleaned, imgs), true);
        for (const b of c) {
          if (b?.type !== "tool_result") continue;
          const callId = b.tool_use_id || o.uuid;
          const sp = o.toolUseResult?.structuredPatch;
          const content = sp?.length
            ? {
                kind: "diff",
                path: o.toolUseResult.filePath || "",
                patch: patchFromStructured(sp, o.toolUseResult.filePath),
              }
            : {
                kind: "text",
                text: contentText(b.content) || (typeof b.content === "string" ? b.content : ""),
              };
          add(
            toolResult(base(`${callId}:o`), { toolCallId: callId, content, isError: !!b.is_error }),
          );
        }
        continue;
      }

      if (o.type === "assistant") {
        const blocks = o.message?.content;
        if (!Array.isArray(blocks)) continue;
        blocks.forEach((b, i) => {
          const id =
            i === 0 ? o.uuid || o.message?.id || `a:${ts}` : `${o.uuid || o.message?.id}:${i}`;
          if (b.type === "thinking" && b.thinking?.trim()) add(thinking(base(id), b.thinking));
          else if (b.type === "text" && b.text?.trim()) add(assistantMessage(base(id), b.text));
          else if (b.type === "tool_use")
            add(toolCall(base(b.id || id), shellify(b.name, b.input)));
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
          const k = (n) =>
            typeof n === "number" ? (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)) : null;
          const span =
            k(m.preTokens) && k(m.postTokens)
              ? ` (${k(m.preTokens)} → ${k(m.postTokens)} tokens)`
              : "";
          // Held so the summary record on the next line can attach itself.
          pendingCompact = add(
            systemEvent(base(o.uuid || `cb:${ts}`), `Conversation compacted${span}`, "info"),
            true,
          );
        }
        continue;
      }
      // mode / attachment / file-history-snapshot / summary: skipped —
      // the old daemon path surfaced none of these in history either.
    }

    const events = turns.flatMap((t) => t.events);
    events.forEach((ev, i) => {
      ev.seq = i + 1;
    });
    if (truncated && !limit) {
      events.unshift(
        systemEvent(
          {
            id: `${threadId}:trunc`,
            conversationId: threadId,
            seq: 0,
            ts: events[0]?.ts || new Date().toISOString(),
          },
          "Older history truncated (thread too large to load fully)",
          "warning",
        ),
      );
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
    try {
      rl = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
    } catch {
      return null;
    }
    try {
      for await (const line of rl) {
        if (!line || !line.includes(uuid)) continue;
        let o;
        try {
          o = JSON.parse(line);
        } catch {
          continue;
        }
        if (o.uuid !== uuid) continue;
        const c = o.message?.content;
        const b = Array.isArray(c) ? c[idx] : null;
        if (b?.type === "image" && b.source?.data) {
          return {
            mediaType: b.source.media_type || "image/png",
            buffer: Buffer.from(b.source.data, "base64"),
          };
        }
        return null;
      }
    } finally {
      rl.close();
    }
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
    const [file, live] = await Promise.all([this.findFile(threadId), cwd ? liveAgentCwds() : null]);
    // null = liveness unknown → the mtime heuristic decides
    const liveInCwd = cwd && live ? (live.get("claude")?.has(cwd) ?? false) : null;
    return judgeTranscript(file, liveInCwd);
  }

  /**
   * Is something OTHER than us appending to this thread's transcript right now?
   *
   * Deliberately cruder than getActivity: any write inside the window counts,
   * whatever the tail looks like, because the tail cannot distinguish "agent
   * finished" from "agent paused mid-turn after some prose". A false positive
   * only delays a follow-up — the user is told to retry — whereas a false
   * negative forks a live session, which is unrecoverable from the app.
   *
   * Our own turns write the same file, so a turn this adapter just ran is
   * excluded; `turns.isRunning` covers one still in flight.
   */
  async isForeignWriter(threadId) {
    if (this.turns.isRunning("claude", threadId)) return false;
    const ownedAt = this.ownWrites.get(threadId);
    if (ownedAt && Date.now() - ownedAt < FOREIGN_WRITE_WINDOW_MS) return false;
    try {
      const file = await this.findFile(threadId);
      if (!file) return false;
      return Date.now() - statSync(file).mtimeMs < FOREIGN_WRITE_WINDOW_MS;
    } catch {
      return false;
    }
  }

  /**
   * Hold a turn until the session another process is driving settles.
   *
   * A thread live in a terminal used to be a dead end: "wait for it to finish,
   * then retry" put the retry on the user, from a phone, for a turn whose end
   * they cannot see. Nothing about the message needed to be lost — only the
   * RESUME had to wait, because resuming mid-turn forks a live agent (see the
   * caller). So park it here and send it the moment the thread goes quiet.
   *
   * NOT a queue on disk: it lives in the open SSE turn, so it dies with the
   * request. Someone who backgrounds the app and never comes back has simply
   * not sent a message, which is the honest outcome — a durable queue would
   * deliver a stale instruction into a session that has since moved on.
   *
   * Resolves true once the thread is quiet, false if it is still busy at the
   * cap — the same refusal as before, just after actually waiting.
   */
  async awaitForeignTurn(
    threadId,
    sessionId,
    onEvent,
    { waitMs = FOREIGN_WAIT_MS, pollMs = FOREIGN_POLL_MS } = {},
  ) {
    onEvent({
      id: `${sessionId}:waiting`,
      conversationId: sessionId,
      seq: 1,
      ts: new Date().toISOString(),
      type: "system_event",
      message:
        "This thread is active in another Claude Code session — holding your message until it finishes.",
      level: "info",
    });
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollMs));
      const act = await this.getActivity(threadId).catch(() => null);
      if (act?.activity === "running") continue;
      // Both checks, same as the guard: `getActivity` reads the transcript's
      // shape and `isForeignWriter` its mtime, and a session between two tool
      // calls can look finished to the first while still being written.
      if (await this.isForeignWriter(threadId)) continue;
      return true;
    }
    return false;
  }

  /**
   * Models come from what this machine can actually show for itself, never a
   * pinned catalog. The CLI has no `models` subcommand and writes no full
   * catalog to disk, so three real sources are merged, best first:
   *
   *   1. versioned ids observed in recent transcripts — every one of these is
   *      an id the API itself returned for this account, so it exists and the
   *      account has access;
   *   2. `additionalModelOptionsCache` in ~/.claude.json — extra options the
   *      CLI caches from the server (promos, `[1m]` long-context variants);
   *   3. family aliases the CLI resolves itself (`opus`, `sonnet`, …), which
   *      always point at the current model and so cannot go stale.
   *
   * The list this replaced was hardcoded, and a hardcoded list goes stale
   * silently — the same failure codex.mjs documents. It still offered Opus 4.8
   * as the default long after Opus 5 shipped, so a thread could not be moved
   * onto a model the account had been using for weeks.
   */
  async listModels() {
    const out = [];
    const have = new Set();
    const push = (id, name, description) => {
      if (!id || have.has(id)) return;
      have.add(id);
      out.push({ id, name: name || id, description: description ?? null, isDefault: false });
    };

    const observed = await observedModels(this.index);
    for (const id of observed) push(id, prettyModel(id), "Used on this machine");
    for (const m of cachedModelOptions()) push(m.id, m.name, m.description);
    for (const a of MODEL_ALIASES) push(a.id, a.name, a.description);

    // Only a model Claude Code is actually configured with is marked default.
    // With nothing configured the CLI picks for itself and no entry here is
    // "the default" — saying otherwise is how the old list came to advertise a
    // superseded model as the one you were getting. An id configured but never
    // seen still gets offered, so the picker can show it as active.
    const configured = configuredModel();
    if (configured) push(configured, prettyModel(configured), "From your Claude Code settings");
    for (const m of out) m.isDefault = configured != null && m.id === configured;

    // A model a newer sibling has replaced is still offered — a thread that ran
    // on it must be able to return to it — but it never sits above a current one.
    markSuperseded(out);
    return [...out.filter((m) => !m.deprecated), ...out.filter((m) => m.deprecated)];
  }

  /**
   * What the config half of the catalog currently says, as a cache key. Change
   * your model in Claude Code and the next /v1/models request re-reads, instead
   * of serving the old answer until a blind TTL happens to lapse.
   *
   * It stamps the MEANING, not the files: an mtime moves every time Claude Code
   * touches ~/.claude.json for unrelated reasons, and this is a cache key, so a
   * spurious change costs a re-read for nothing. Transcripts are deliberately
   * absent for the same reason — they change on every turn, and stamping them
   * would re-read forty file tails per request. A newly-observed model arrives
   * with the ordinary TTL instead.
   */
  modelsSignature() {
    return JSON.stringify([configuredModel(), cachedModelOptions().map((m) => m.id)]);
  }

  /**
   * Run one turn headlessly. Fresh threads pre-generate the session id
   * (--session-id) so the real thread id is known before the first byte.
   * Input goes over stdin as one stream-json user message (works for plain
   * text and base64 images alike, and dodges argv size/quoting limits).
   */
  async startTurn(
    { threadId, text, cwd, images, permissionMode, reasoningEffort, model },
    onEvent,
  ) {
    this.turns.assertCapacity();
    const fresh = !threadId || !/^[0-9a-f]{8}-/i.test(threadId);
    const sessionId = fresh ? randomUUID() : threadId;

    if (!fresh) {
      if (this.turns.isRunning("claude", threadId)) {
        return failedTurn(
          sessionId,
          "A turn is already running for this thread — interrupt it first.",
          onEvent,
        );
      }
      // Resuming a session that's mid-turn in ANOTHER process (a terminal /
      // FleetView session) forks a live agent that keeps working the original
      // task with full permissions — observed forking a session that then
      // killed this very bridge. Refuse while the transcript tail shows an
      // in-flight turn; the user can retry once it settles.
      //
      // getActivity alone is not enough: judgeTranscript calls an assistant
      // turn ending in TEXT "completed" whatever its age, which is right for
      // the thread list but wrong here — an agent that has just written prose
      // between two tool calls looks exactly like one that finished. That gap
      // let a resume through and forked a live session (the fork replayed the
      // whole conversation into a new id, which then surfaced as a duplicate
      // thread). So this path also refuses on a transcript that is simply
      // still being written.
      //
      // Waiting is the answer, not refusing: only the RESUME has to wait, and
      // asking someone on a phone to retry at the right moment made them poll a
      // turn whose end they can't see. Held here, sent the instant it settles.
      const act = await this.getActivity(threadId).catch(() => null);
      if (act?.activity === "running" || (await this.isForeignWriter(threadId))) {
        if (!(await this.awaitForeignTurn(threadId, sessionId, onEvent))) {
          return failedTurn(
            sessionId,
            "This thread is still active in another Claude Code session on the host — your message wasn't sent. Try again once that session is done.",
            onEvent,
          );
        }
      }
    }

    const args = [
      "-p",
      "--verbose",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--input-format",
      "stream-json",
    ];
    args.push(fresh ? "--session-id" : "--resume", sessionId);
    // The daemon ran with bypass_permissions=true (host.toml) — headless turns
    // can't answer permission prompts, so "default" maps to bypass to keep the
    // phone UX working. Explicit non-default modes pass through verbatim.
    const mode =
      permissionMode && permissionMode !== "default" ? permissionMode : "bypassPermissions";
    args.push("--permission-mode", mode);
    if (model) args.push("--model", model);
    const effort = { minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "high" }[
      reasoningEffort
    ];
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
        return failedTurn(
          sessionId,
          `This thread's folder no longer exists (${cwd || meta?.cwd || "unknown"}) — it can't be resumed. Start a new conversation instead.`,
          onEvent,
        );
      }
    }
    if (!dir) dir = os.homedir();
    let child;
    try {
      child = spawn(binPath("claude"), args, {
        cwd: dir,
        env: agentEnv(),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (e) {
      return failedTurn(sessionId, String(e?.message || e), onEvent);
    }
    const entry = this.turns.register("claude", [sessionId, threadId], child);

    const content = [{ type: "text", text }];
    for (const img of images || []) {
      if (img?.data)
        content.push({
          type: "image",
          source: { type: "base64", media_type: img.mediaType || "image/png", data: img.data },
        });
    }
    try {
      child.stdin.write(
        JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n",
      );
      child.stdin.end();
    } catch {}

    let seq = 0;
    let sawReply = false; // any assistant/tool event reached the client
    const now = () => new Date().toISOString();
    const base = (id) => ({ id, conversationId: sessionId, seq: ++seq, ts: now() });
    const emit = (ev) => {
      if (ev.type !== "user_message" && ev.type !== "system_event") sawReply = true;
      try {
        onEvent(ev);
      } catch {}
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
    const done = new Promise((res, rej) => {
      resolveDone = res;
      rejectDone = rej;
    });
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      acc.clear();
      this.turns.release(entry);
      // Stamp both ids: a resume can report a different session_id than we asked
      // for, and either may be the one a follow-up resumes.
      this.ownWrites.set(sessionId, Date.now());
      if (threadId) this.ownWrites.set(threadId, Date.now());
      // Resuming a session that's LIVE in another window (terminal/FleetView)
      // doesn't run an independent turn — claude delivers the message into the
      // running session and returns without a reply, and the child can linger.
      // Tell the phone what happened instead of ending in silence…
      if (!err && !sawReply) {
        emit(
          systemEvent(
            base(`${sessionId}:live`),
            "No reply here — this thread appears active in another window; your message was delivered to that session.",
            "warning",
          ),
        );
      }
      // …and never leak the child: if it survives the result, reap it.
      setTimeout(() => {
        if (child.exitCode === null) {
          console.log(
            `[turn] claude lingering child pid=${child.pid} thread=${sessionId} — reaping`,
          );
          try {
            child.kill("SIGKILL");
          } catch {}
        }
      }, 5000).unref?.();
      if (err) rejectDone(err);
      else resolveDone(sessionId);
    };

    const handle = (o) => {
      if (o.type === "system" && o.subtype === "init") {
        if (o.session_id) this.turns.alias(entry, "claude", o.session_id);
        // The init envelope is the CLI's own command list for THIS cwd — the
        // only enumeration the stream-json transport offers. Free here, so the
        // composer's menu stays current without a probe spawn.
        rememberCommands(
          "cli",
          "claude",
          dir,
          normalizeCliCommands(o.slash_commands, o.terminal_slash_commands),
        );
        return;
      }
      if (o.type === "stream_event") {
        const ev = o.event || {};
        if (ev.type === "message_start") {
          msgN++;
          return;
        }
        if (ev.type === "content_block_delta") {
          const key = `${sessionId}:${msgN}:${ev.index}`;
          const d = ev.delta || {};
          const piece =
            d.type === "text_delta" ? d.text : d.type === "thinking_delta" ? d.thinking : null;
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
          emit(
            toolResult(base(`${callId}:o`), {
              toolCallId: callId,
              content: {
                kind: "text",
                text: contentText(b.content) || (typeof b.content === "string" ? b.content : ""),
              },
              isError: !!b.is_error,
            }),
          );
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
        // The ONLY place Claude Code reports real dollars: total_cost_usd rides
        // this envelope and is never written to ~/.claude/projects/**.jsonl, so
        // it's gone the moment this process exits. Persist it before finishing.
        recordTurn(turnMetrics(sessionId, o));
        // Surface any non-success outcome — "no conversation found", API
        // errors, execution errors — or the app just sees a silent no-op.
        if (o.is_error || (o.subtype && o.subtype !== "success")) {
          emit(
            systemEvent(
              base(`${sessionId}:err`),
              String(o.result || o.subtype || "turn failed"),
              "error",
            ),
          );
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
      console.log(
        `[turn] claude exit code=${code} thread=${sessionId} in ${Math.round((Date.now() - t0) / 1000)}s ${sawResult ? "(result)" : "(no result)"}${code !== 0 ? ` stderr: ${stderrTail.trim().slice(-300)}` : ""}`,
      );
      if (!sawResult && code !== 0 && !settled) {
        emit(
          systemEvent(
            base(`${sessionId}:err`),
            `claude exited (${code}): ${stderrTail.trim().slice(-500)}`,
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
          base(`${sessionId}:err`),
          `claude failed to start: ${e?.message || e}`,
          "error",
        ),
      );
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
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    return { activity: "idle", lastActivityAt: null };
  }
  const lastActivityAt = new Date(mtimeMs).toISOString();
  const sinceWrite = Date.now() - mtimeMs;
  const windowMs = liveInCwd ? LIVE_EXTENDED_WINDOW_MS : RUNNING_WINDOW_MS;
  const recent = liveInCwd !== false && sinceWrite < windowMs;

  // Walk the tail backwards to the last meaningful record.
  const lines = readTailLines(file);
  for (let i = lines.length - 1; i >= 0; i--) {
    let o;
    try {
      o = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (o.type === "assistant") {
      const blocks = o.message?.content || [];
      const lastBlock = Array.isArray(blocks) ? blocks[blocks.length - 1] : null;
      // Ends on tool_use → a tool is (was) executing; text → the agent finished.
      if (lastBlock?.type === "tool_use")
        return { activity: recent ? "running" : "completed", lastActivityAt };
      return { activity: "completed", lastActivityAt };
    }
    if (o.type === "user") {
      // Neither meta records nor the compaction summary are a pending prompt.
      if (o.isMeta || isTranscriptOnly(o)) continue;
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
      id: `${threadId}:spawn-err`,
      conversationId: threadId,
      seq: 1,
      ts: new Date().toISOString(),
      type: "system_event",
      message,
      level,
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
    let cwd = null,
      createdAt = null,
      gitBranch = null,
      name = null;
    let preview = null; // first real prose message — what a human titles it
    let previewFallback = null; // first slash-command chip, if that's all there is
    let sawUserLine = false;
    let lines = 0,
      bytes = 0;
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
      // A `/rename` beats any generated title — that is the SDK's own precedence
      // (customTitle || aiTitle) and it is what the user asked to see. Kept
      // separate from `name` so a late ai-title cannot displace it.
      let customTitle = null;
      for (const line of readTailLines(file).reverse()) {
        if (!customTitle && line.includes('"custom-title"')) {
          try {
            const o = JSON.parse(line);
            if (o.type === "custom-title" && o.customTitle)
              customTitle = String(o.customTitle).slice(0, 200);
          } catch {}
        }
        if (!name && line.includes('"ai-title"')) {
          try {
            const o = JSON.parse(line);
            if (o.type === "ai-title" && o.aiTitle) name = String(o.aiTitle).slice(0, 200);
          } catch {}
        }
        if (!permissionMode && line.includes("permissionMode")) {
          try {
            const o = JSON.parse(line);
            if (typeof o.permissionMode === "string")
              permissionMode = CLAUDE_MODE[o.permissionMode] || null;
          } catch {}
        }
        if (customTitle && name && permissionMode) break;
      }
      resolve({
        id,
        filePath: file,
        cwd,
        name: customTitle || name,
        preview: preview || previewFallback,
        createdAt,
        updatedAt: new Date(st.mtimeMs).toISOString(),
        gitBranch,
        sizeBytes: st.size,
        permissionMode,
      });
    };
    rl.on("line", (line) => {
      lines++;
      bytes += line.length;
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
            const raw =
              typeof o.message.content === "string"
                ? o.message.content
                : contentText(o.message.content);
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
