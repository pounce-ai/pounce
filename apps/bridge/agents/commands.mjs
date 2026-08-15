/**
 * The slash commands an agent really offers, per agent + working directory.
 *
 * Pounce used to ship a hand-kept list of six in the app, which was both far
 * short of the ~95 a real install has (every plugin, skill, and project command)
 * and wrong in detail — the two transports don't accept the same set. Both of
 * them CAN enumerate, so neither has to be guessed at:
 *
 *   - stream-json (`claude -p`): the `system`/`init` envelope carries
 *     `slash_commands` (names only) and `terminal_slash_commands` (the subset
 *     whose UI only exists in the CLI's own terminal).
 *   - ACP: the adapter pushes `available_commands_update` after session/new,
 *     with descriptions and argument hints, and re-pushes when the set changes.
 *
 * Both write here so whichever transport a session uses, the composer offers a
 * list that actually works on it. The lists genuinely differ — `/clear` runs
 * under -p and is refused over ACP — so the cache is keyed by transport too,
 * and a caller asks for the one it will actually run on.
 *
 * Note neither transport offers `/skills` or `/btw`. Those render an Ink
 * component in the CLI's TUI and have no non-terminal implementation, so the
 * CLI rejects them ("isn't available in this environment") without reaching the
 * model. They are absent on purpose; do not add them back by hand.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import os from "node:os";
import { createInterface } from "node:readline";
import { agentEnv, binPath } from "./env.mjs";

/** `${transport}:${agent}:${cwd}` → AgentCommand[] */
const store = new Map();

const key = (transport, agent, cwd) => `${transport}:${agent}:${cwd || ""}`;

/** Record a freshly-seen list. Empty lists are ignored: an agent that reported
 *  nothing is a probe that failed, not an agent with no commands, and caching
 *  it would pin that failure for the whole TTL. */
export function rememberCommands(transport, agent, cwd, commands) {
  if (commands?.length) store.set(key(transport, agent, cwd), commands);
}

/** Last list seen for this transport+agent+cwd, or null. */
export function cachedCommands(transport, agent, cwd) {
  return store.get(key(transport, agent, cwd)) || null;
}

/** ACP's `availableCommands` → the app's shape, keeping the leading slash the
 *  UI renders. ACP is the richer source: it carries descriptions and hints. */
export function normalizeAcpCommands(list) {
  return (Array.isArray(list) ? list : [])
    .filter((c) => typeof c?.name === "string" && c.name)
    .map((c) => ({
      cmd: `/${c.name}`,
      desc: typeof c.description === "string" ? c.description : "",
      ...(c.input?.hint ? { hint: String(c.input.hint) } : {}),
    }));
}

/**
 * The init envelope's `slash_commands` → the app's shape. Names only — the CLI
 * doesn't describe them on this channel, so rows render bare rather than with
 * a made-up description.
 *
 * `terminal_slash_commands` is subtracted: those are the ones the CLI itself
 * flags as belonging to its terminal UI (`/color`, `/doctor`, …). They'd be
 * accepted and then do nothing visible in Pounce, which is worse than absent.
 */
export function normalizeCliCommands(names, terminalNames) {
  const terminal = new Set(Array.isArray(terminalNames) ? terminalNames : []);
  return (Array.isArray(names) ? names : [])
    .filter((n) => typeof n === "string" && n && !terminal.has(n))
    .map((n) => ({ cmd: `/${n}`, desc: "" }));
}

/**
 * Read the CLI's command list without running a turn.
 *
 * A live turn fills the cache for free (see claude.mjs), but the composer needs
 * the menu before the FIRST message — so a thread with no turns yet would have
 * nothing.
 *
 * The CLI only reaches `init` once it has a prompt to start on, so one is sent
 * and the child is killed the instant `init` arrives. That is still free, and
 * measured rather than assumed: the only envelopes preceding `init` are the
 * SessionStart hooks, the model call is what comes AFTER it, and a probe run
 * leaves no transcript on disk. The throwaway `--session-id` keeps it off any
 * real thread even if that ever changes.
 */
export function readCliCommands(agent, cwd, { timeoutMs = 30_000 } = {}) {
  if (agent !== "claude") return Promise.resolve([]); // only claude emits init
  const dir = cwd && existsSync(cwd) ? cwd : os.homedir();
  let child;
  try {
    child = spawn(
      binPath("claude"),
      [
        "-p",
        "--verbose",
        "--output-format",
        "stream-json",
        "--input-format",
        "stream-json",
        "--session-id",
        randomUUID(),
      ],
      { cwd: dir, env: agentEnv(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
  } catch {
    return Promise.resolve([]);
  }
  child.stderr.resume();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (out) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill("SIGKILL");
      } catch {}
      rememberCommands("cli", agent, dir, out);
      resolve(out);
    };
    const timer = setTimeout(() => finish([]), timeoutMs).unref?.();
    child.on("error", () => finish([]));
    child.on("exit", () => finish([]));
    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        return;
      }
      if (o?.type === "system" && o.subtype === "init")
        finish(normalizeCliCommands(o.slash_commands, o.terminal_slash_commands));
    });
    // The prompt the CLI needs to get as far as `init`. Never answered — we're
    // gone before the model is called.
    try {
      child.stdin.write(
        `${JSON.stringify({
          type: "user",
          message: { role: "user", content: [{ type: "text", text: "hi" }] },
        })}\n`,
      );
    } catch {
      finish([]);
    }
  });
}
