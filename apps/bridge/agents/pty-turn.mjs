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
import { detectPrompt, answerKeys, writeKeys } from "./prompt-detect.mjs";
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

/** Path to a thread's on-disk transcript, if one exists (for resume). */
function transcriptFile(threadId) {
  try {
    for (const dir of readdirSync(ROOT)) {
      const f = path.join(ROOT, dir, `${threadId}.jsonl`);
      if (existsSync(f)) return f;
    }
  } catch {}
  return null;
}

/** The cwd a transcript was recorded under — a `--resume` MUST run from it or
 *  claude reports "no conversation found". */
function cwdFromTranscript(file) {
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line) continue;
      try {
        const o = JSON.parse(line);
        if (o.cwd) return o.cwd;
      } catch {}
    }
  } catch {}
  return null;
}

function transcriptRows(threadId) {
  const f = transcriptFile(threadId);
  if (!f) return [];
  try {
    return readFileSync(f, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {}
  return [];
}

/** How many assistant records with content the transcript holds — the count
 *  grows by one each time a turn produces output (an AskUserQuestion tool_use is
 *  itself such a record), so a rise past a baseline means "our turn started". */
function assistantCount(rows) {
  return rows.filter(
    (o) => o.type === "assistant" && Array.isArray(o.message?.content) && o.message.content.length,
  ).length;
}

/**
 * Any interactive prompt the hosted CLI is blocked on — trust-folder, tool
 * permission, plan approval, AskUserQuestion, any numbered menu — detected
 * GENERICALLY from the rendered terminal screen (see prompt-detect.mjs), not a
 * per-agent transcript call. Returns `{ promptId, title, kind, options,
 * highlighted, multiSelect }` or null. Only reports for PTY-hosted sessions.
 */
export function pendingPrompt(threadId) {
  const session = ptys.get(threadId);
  if (!session) return null;
  const p = detectPrompt(session.screenLines());
  if (!p) return null;
  // Stable-ish id so the app doesn't re-mount the card every poll: thread + the
  // option set (a new prompt with different options gets a new id).
  const promptId = `${threadId}:${p.options
    .map((o) => o.label)
    .join("|")
    .slice(0, 80)}`;
  return { promptId, ...p };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Plain-text user records, in file (append) order. */
function userRecords(rows) {
  return rows.filter((o) => o.type === "user" && typeof o.message?.content === "string");
}

/**
 * Submit `text` into the TUI, deterministically. claude's render is noisy and
 * variable, so a fixed type+Enter is occasionally dropped. Instead: clear the
 * composer (Ctrl-U, so a retry can't duplicate the prompt), type, Enter, and
 * RETRY until the turn is active. We stop the instant it's active, so a retry
 * can never leak an Enter into a later picker. Async, fire-and-forget; never
 * throws.
 *
 * Success is judged RELATIVE to a baseline captured up front — a NEW user
 * record carrying our prompt, or a NEW assistant record — never prior history.
 * A follow-up / `--resume` starts with a non-empty transcript, so an absolute
 * check ("any user record contains our text", "any assistant record exists")
 * would read as "already done" and skip the submit; worse, a follow-up sharing
 * a prefix with an earlier prompt would match the OLD record. Baseline-relative
 * fixes both.
 */
async function submitPrompt(session, threadId, text) {
  const prompt = String(text || "").trim();
  if (!prompt) return;
  const key = prompt.slice(0, 40);
  const rows0 = transcriptRows(threadId);
  const baseUsers = userRecords(rows0).length;
  const baseAsst = assistantCount(rows0);
  // Our prompt landed = a user record ADDED past the baseline that carries it;
  // or the turn already produced a new assistant record.
  const done = () => {
    const rows = transcriptRows(threadId);
    const landed = userRecords(rows)
      .slice(baseUsers)
      .some((o) => o.message.content.includes(key));
    return landed || assistantCount(rows) > baseAsst;
  };
  await sleep(3000); // let the TUI finish its (startup / resume) render
  // Never type over a blocking prompt (trust-folder / permission shown BEFORE the
  // composer): that would blindly answer it with the default. Queue the prompt
  // behind it — wait (bounded) for the app/user to answer it and the composer to
  // appear. If it never clears, give up rather than type into the dialog.
  for (let w = 0; w < 180 && detectPrompt(session.screenLines()); w++) await sleep(1000);
  if (detectPrompt(session.screenLines())) return;
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

/**
 * Spawn (or reuse) an interactive PTY for a thread and submit `text`. Returns
 * the real threadId.
 *
 * Reuse over spawn, mirroring claude.mjs's `fresh ? --session-id : --resume`,
 * so relaunching a thread continues the SAME session instead of minting a new
 * one (one test thread, not 28):
 *   - a LIVE PTY for this thread → submit into it (never fork a second claude);
 *   - an existing on-disk session → `--resume` it from its own cwd;
 *   - otherwise a FRESH session (`--session-id <uuid>`).
 */
export function startInteractiveSession({ threadId, text, cwd, model }) {
  const valid = threadId && /^[0-9a-f]{8}-/i.test(threadId);

  // Already hosting a live PTY for this thread — drive it directly. Resuming an
  // already-running claude would fork a second agent onto the same transcript.
  if (valid && ptys.has(threadId)) {
    void submitPrompt(ptys.get(threadId), threadId, text).catch(() => {});
    return threadId;
  }

  const resumeFile = valid ? transcriptFile(threadId) : null;
  const sessionId = valid ? threadId : randomUUID();
  // Resume must run from the thread's own cwd; prefer the caller's, fall back to
  // the one recorded in the transcript, then $HOME (fresh sessions only).
  const dir =
    cwd && existsSync(cwd)
      ? cwd
      : resumeFile
        ? cwdFromTranscript(resumeFile) || os.homedir()
        : os.homedir();
  const args = resumeFile ? ["--resume", sessionId] : ["--session-id", sessionId];
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

/**
 * Answer a pending prompt by selecting option `optionIndex` (0-based into the
 * detected options). Generic: re-detect the CURRENT highlight off the screen,
 * move to the target, press Enter — works for trust / permission / plan /
 * AskUserQuestion / any menu. Returns true if a prompt was present and driven.
 */
export async function answerPrompt(threadId, optionIndex) {
  const session = ptys.get(threadId);
  if (!session) return false;
  const p = detectPrompt(session.screenLines()); // fresh: highlight may have moved
  if (!p) return false;
  const target = Math.max(0, Math.min(Number(optionIndex) || 0, p.options.length - 1));
  const keys = answerKeys(p.highlighted, target);
  console.log(
    `[answer] thread=${threadId} "${p.options[target]?.label}" (${p.highlighted}→${target})`,
  );
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
