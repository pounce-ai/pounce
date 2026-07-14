/**
 * Interactive PTY sessions — the answerable turn path.
 *
 * Headless `-p` turns bypass permissions and can't show AskUserQuestion; ACP
 * turns need the adapter bundled. This path spawns claude's REAL TUI inside a
 * zigpty PTY (see pty.mjs), so the agent can ask interactive questions and the
 * app can answer them by having the bridge drive the picker keystrokes. claude
 * still writes its normal transcript, so the timeline comes through the usual
 * getMessages/getEvents path untouched — this module only adds (a) launching the
 * TUI, (b) surfacing a pending AskUserQuestion, and (c) answering it.
 *
 * claude-only for now; codex/opencode have different interactive models.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PtyManager } from "./pty.mjs";
import { parseAskUserQuestion, answerKeystrokes, writeKeys, describeKeys } from "./askquestion.mjs";
import { agentEnv, binPath } from "./env.mjs";

const ROOT = path.join(os.homedir(), ".claude", "projects");

/** Live interactive PTY sessions, keyed by threadId. Only these are answerable. */
const ptys = new PtyManager();

export function isInteractive(threadId) {
  return ptys.has(threadId);
}

/** A bridge must never spawn a claude that thinks it's a nested child — strip the
 *  markers a parent claude session would set (harmless when absent in prod). */
function cleanEnv() {
  const env = agentEnv();
  for (const k of Object.keys(env)) {
    if (/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_EFFORT|CLAUDE_PLUGIN|SUPERSET_)/.test(k)) delete env[k];
  }
  return env;
}

function transcriptRows(threadId) {
  try {
    for (const dir of readdirSync(ROOT)) {
      const f = path.join(ROOT, dir, `${threadId}.jsonl`);
      if (existsSync(f)) {
        return readFileSync(f, "utf8").split("\n").filter(Boolean)
          .map((l) => { try { return JSON.parse(l); } catch { return null; } })
          .filter(Boolean);
      }
    }
  } catch {}
  return [];
}

/** True once the agent has produced any turn output (used to gate a submit retry). */
function turnStarted(rows) {
  return rows.some((o) => o.type === "assistant" && Array.isArray(o.message?.content) && o.message.content.length);
}

/** The last AskUserQuestion tool_use with no matching tool_result — the raw block. */
function pendingRaw(threadId) {
  const rows = transcriptRows(threadId);
  let tu = null;
  const done = new Set();
  for (const o of rows) {
    const c = Array.isArray(o.message?.content) ? o.message.content : [];
    if (o.type === "assistant") for (const b of c) { if (b?.type === "tool_use" && b?.name === "AskUserQuestion") tu = b; }
    else if (o.type === "user") for (const b of c) { if (b?.type === "tool_result") done.add(b.tool_use_id); }
  }
  return tu && !done.has(tu.id) ? tu : null;
}

/** Pending AskUserQuestion for a thread as `{ questionId, questions }`, or null.
 *  Only reports for PTY-hosted sessions (the app can only answer those). */
export function pendingQuestion(threadId) {
  if (!ptys.has(threadId)) return null;
  const tu = pendingRaw(threadId);
  if (!tu) return null;
  const questions = parseAskUserQuestion(tu.input);
  return questions ? { questionId: tu.id, questions } : null;
}

/**
 * Type the prompt into the freshly-spawned TUI and submit it. The paste needs to
 * settle before Enter, and submission is occasionally dropped — so we retry Enter
 * once, but ONLY while the turn hasn't started AND no picker is on screen (a bare
 * Enter into a picker would select its default). Best-effort; never throws.
 */
function submitPrompt(session, threadId, text) {
  const prompt = String(text || "").trim();
  if (!prompt) return;
  setTimeout(() => {
    session.write(prompt);
    setTimeout(() => session.write("\r"), 600);
  }, 3500); // let the input box render first
  // one guarded retry
  setTimeout(() => {
    if (turnStarted(transcriptRows(threadId)) || pendingRaw(threadId)) return;
    const screen = session.snapshot().replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
    if (/to select|navigate|❯/i.test(screen)) return; // a picker is up — don't Enter
    session.write("\r");
  }, 12000);
}

/** Spawn claude's TUI in a PTY and submit `text`. Returns the real threadId. */
export function startInteractiveSession({ threadId, text, cwd, model }) {
  const fresh = !threadId || !/^[0-9a-f]{8}-/i.test(threadId);
  const sessionId = fresh ? randomUUID() : threadId;
  const dir = cwd && existsSync(cwd) ? cwd : os.homedir();
  const args = ["--session-id", sessionId];
  if (model) args.push("--model", model);
  const session = ptys.create(sessionId, {
    command: binPath("claude"),
    args,
    cwd: dir,
    env: cleanEnv(),
    cols: 120,
    rows: 40,
  });
  submitPrompt(session, sessionId, text);
  return sessionId;
}

/** Answer a pending AskUserQuestion by driving the picker keystrokes. `answers`
 *  is the chosen option indices per question. Returns true if answered. */
export async function answerQuestion(threadId, answers) {
  const session = ptys.get(threadId);
  if (!session) return false;
  const pq = pendingQuestion(threadId);
  if (!pq) return false;
  const keys = answerKeystrokes(pq.questions, answers);
  console.log(`[answer] thread=${threadId} keys=${describeKeys(keys)}`);
  await writeKeys((b) => session.write(b), keys);
  return true;
}

/** Send raw input to an interactive session's PTY (steer / free text). */
export function sendInput(threadId, data) {
  const session = ptys.get(threadId);
  if (!session) return false;
  session.write(data);
  return true;
}

export function stopInteractive(threadId) {
  return ptys.kill(threadId, "SIGTERM");
}
