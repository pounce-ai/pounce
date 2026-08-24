/**
 * The machine denylist — the layer only an at-source scrubber can have.
 *
 * Pattern rules guess at what a secret looks like. This one doesn't guess: it
 * reads the credentials that are actually live on THIS machine — the agent's
 * own stored tokens, the project's `.env`, secret-shaped environment variables
 * — and redacts exact matches. Zero false positives by construction, and it
 * catches the credentials that matter most, because a secret sitting in
 * `~/.claude/.credentials.json` is one an attacker can use today.
 *
 * A server-side scrubber cannot do this at any quality. By the time the
 * payload reaches a collector, the environment that would identify these
 * values is gone. This is the whole difference between scrubbing at the source
 * and scrubbing after the fact, and it is the part worth building.
 *
 * WHAT THIS DELIBERATELY DOES NOT READ. Not the macOS Keychain: reading it
 * means spawning `security`, which can block on a user prompt, and a scrubber
 * that hangs is a scrubber that gets turned off. Not arbitrary files under the
 * project — only the `.env` family, by exact name. Not anything at all unless
 * the caller asked, since harvesting is I/O and the metrics tier needs none of
 * it.
 *
 * The values collected here never leave this process: they are held to compare
 * against, and a finding reports only that the denylist matched.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Below this length a "secret" is more likely to be a substring of ordinary
 * prose, and redacting every occurrence of it would gut the document. A short
 * credential is a real risk we accept rather than shred the payload.
 */
const MIN_SECRET_LENGTH = 12;

/** Same idea, stricter, for values we infer from a JSON blob rather than a name. */
const MIN_INFERRED_LENGTH = 20;

/** Environment variable names whose value is a credential. */
const SECRET_ENV =
  /(?:secret|token|passwd|password|api[_-]?key|apikey|credential|private[_-]?key|access[_-]?key|client[_-]?secret|_auth)/i;

/**
 * Values common enough that redacting them everywhere would be worse than the
 * leak — a short shared word that happens to sit in a secret-named variable.
 */
const NEVER = new Set(["true", "false", "null", "undefined", "localhost", "changeme"]);

function addValue(out, value, min) {
  if (typeof value !== "string") return;
  const v = value.trim();
  if (v.length < min) return;
  if (NEVER.has(v.toLowerCase())) return;
  out.add(v);
}

/** Collect string leaves from a parsed JSON credential store. */
function walkJson(node, out, depth = 0) {
  if (depth > 6 || node == null) return;
  if (typeof node === "string") return addValue(out, node, MIN_INFERRED_LENGTH);
  if (Array.isArray(node)) {
    for (const v of node) walkJson(v, out, depth + 1);
    return;
  }
  if (typeof node === "object") {
    for (const v of Object.values(node)) walkJson(v, out, depth + 1);
  }
}

function readJsonSafe(file) {
  try {
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // An unreadable or malformed credential store is not an error worth
    // failing a redaction over — it just contributes nothing.
    return null;
  }
}

/** Parse `KEY=value` lines, honouring quotes and ignoring comments. */
function parseEnvFile(file, out) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    let value = trimmed.slice(eq + 1).trim();
    // `export FOO=bar` and quoted values are both ordinary in a .env.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // Every value in a .env is a candidate regardless of its name — that file
    // exists to hold configuration you don't commit.
    addValue(out, value, MIN_SECRET_LENGTH);
  }
}

/**
 * Gather the live credentials on this machine.
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd] Project directory whose `.env` family to read.
 * @param {string[]} [opts.extra] Values the caller already knows are secret —
 *   the bridge passes its own token and admin API key here.
 * @param {boolean} [opts.env] Read secret-named environment variables (default true).
 * @param {string} [opts.home] Override the home directory (tests).
 * @returns {string[]} Longest first, so the most specific match redacts first.
 */
export function harvestMachineSecrets(opts = {}) {
  const { cwd = null, extra = [], env = true, home = os.homedir() } = opts;
  const out = new Set();

  for (const v of extra) addValue(out, v, MIN_SECRET_LENGTH);

  if (env) {
    for (const [key, value] of Object.entries(process.env)) {
      if (SECRET_ENV.test(key)) addValue(out, value, MIN_SECRET_LENGTH);
    }
  }

  // Agent credential stores. These are the tokens that buy an attacker the
  // user's own model access, which makes them the highest-value strings on
  // the machine and the ones most likely to be echoed into a transcript by a
  // debugging session gone sideways.
  for (const file of [
    path.join(home, ".claude", ".credentials.json"),
    path.join(home, ".codex", "auth.json"),
    path.join(home, ".config", "opencode", "auth.json"),
    path.join(home, ".pounce", "config.json"),
  ]) {
    walkJson(readJsonSafe(file), out);
  }

  // The project's own uncommitted configuration.
  if (cwd) {
    let entries = [];
    try {
      entries = readdirSync(cwd);
    } catch {
      entries = [];
    }
    for (const name of entries) {
      if (name === ".env" || name.startsWith(".env.")) parseEnvFile(path.join(cwd, name), out);
    }
  }

  return [...out].sort((a, b) => b.length - a.length);
}
