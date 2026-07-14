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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** True once the turn is actually underway, judged by the TRANSCRIPT (not the
 *  noisy TUI): a real assistant record landed, or an AskUserQuestion tool_use is
 *  already pending. The on-screen "esc to interrupt" hint false-positives before
 *  the turn produces anything, so we don't trust it. */
function turnActive(threadId) {
  return turnStarted(transcriptRows(threadId)) || !!pendingRaw(threadId);
}

/** Whether our prompt has landed as a user record — i.e. the submit was
 *  accepted. Once true, the turn is queued: stop touching the composer so a
 *  retry can't type a duplicate or Enter into a picker. */
function promptAccepted(threadId, prompt) {
  const key = prompt.slice(0, 40);
  return transcriptRows(threadId).some(
    (o) => o.type === "user" && typeof o.message?.content === "string" && o.message.content.includes(key),
  );
}

/**
 * Submit `text` into the freshly-spawned TUI, deterministically. claude's
 * startup render is noisy and variable, so a fixed type+Enter is occasionally
 * dropped. Instead: clear the composer (Ctrl-U, so a retry can't duplicate the
 * prompt), type, Enter, and RETRY until the turn is active. We stop the instant
 * it's active, so a retry can never leak an Enter into a later picker. Async,
 * fire-and-forget; never throws.
 */
async function submitPrompt(session, threadId, text) {
  const prompt = String(text || "").trim();
  if (!prompt) return;
  const done = () => promptAccepted(threadId, prompt) || turnActive(threadId);
  await sleep(3000); // let the TUI finish its startup render
  for (let i = 0; i < 10 && !done(); i++) {
    // Only (re)type while the prompt still hasn't been accepted — the moment it
    // lands as a user record we stop, so no duplicate submit and no Enter can
    // reach a later picker. Ctrl-U first so an incomplete earlier type is cleared.
    session.write("\x15"); // Ctrl-U — clear the composer
    await sleep(150);
    session.write(prompt);
    await sleep(500);
    session.write("\r"); // submit
    for (let w = 0; w < 7 && !done(); w++) await sleep(650); // ~4.5s for it to land
  }
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
  void submitPrompt(session, sessionId, text).catch(() => {});
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
