/**
 * PTY session host — the bridge's control channel into interactive agent CLIs.
 *
 * Headless `-p` turns (claude.mjs) and structured ACP turns (acp.mjs) can't
 * answer an interactive prompt: `--print` bypasses permissions and never shows
 * AskUserQuestion. To let the app answer those prompts, the bridge spawns the
 * agent's REAL terminal UI inside a pseudo-terminal (via zigpty) so it can:
 *   - stream the live terminal bytes to the app (a remote terminal), and
 *   - write keystrokes back — selecting an option, typing an answer, ^C, etc.
 *
 * zigpty's IdleDetector turns the byte stream into an "awaiting input" signal
 * (output bursts then goes quiet), which maps onto the app's `awaiting_input`
 * activity so a blocked session surfaces as "Needs you". The agent still writes
 * its normal ~/.claude/projects transcript, so the structured timeline is
 * unchanged — the PTY is purely the interaction channel layered on top.
 *
 * Native binding ships as prebuilt N-API (.node) per platform; on an
 * unsupported host zigpty falls back to a pure-JS pipe (no real TTY, so TUIs
 * won't render) — callers should check {@link ptyNative} before relying on it.
 */
import { spawn, hasNative } from "zigpty";
import { IdleDetector } from "zigpty/idle";

/** True when the native PTY binding loaded (real TTY). False → pipe fallback. */
export const ptyNative = hasNative;

/** Scrollback kept per session so a client that (re)connects mid-session can
 *  paint the current screen without the earlier bytes. Bounded to cap memory. */
const MAX_SCROLLBACK = 256 * 1024;

/**
 * One hosted PTY. Wraps a zigpty child with a bounded scrollback buffer, a
 * fan-out for live output/idle subscribers (SSE clients), and an idle→
 * awaiting-input signal. Keyed by the agent thread id it backs.
 */
export class PtySession {
  /**
   * @param {string} id  thread id this PTY backs
   * @param {object} opts
   * @param {string} opts.command  executable to run (the agent CLI)
   * @param {string[]} [opts.args]
   * @param {string} [opts.cwd]
   * @param {Record<string,string>} [opts.env]
   * @param {number} [opts.cols=120]
   * @param {number} [opts.rows=32]
   * @param {number} [opts.quietMs]  idle detector quiet window (ms)
   */
  constructor(id, { command, args = [], cwd, env, cols = 120, rows = 32, quietMs } = {}) {
    this.id = id;
    this.cols = cols;
    this.rows = rows;
    this.idle = false;
    this.exitCode = null;
    this.startedAt = Date.now();
    this._scrollback = "";
    this._dataSinks = new Set();
    this._idleSinks = new Set();

    this._pty = spawn(command, args, {
      cols,
      rows,
      name: "xterm-256color",
      encoding: "utf8",
      ...(cwd ? { cwd } : {}),
      ...(env ? { env } : {}),
    });
    this.pid = this._pty.pid;

    this._pty.onData((d) => {
      const s = typeof d === "string" ? d : d.toString("utf8");
      this._append(s);
      for (const sink of this._dataSinks) { try { sink(s); } catch {} }
    });

    // active↔idle transitions. `idle` after an output burst = the CLI is
    // blocked waiting for the user (a prompt / question). See IdleDetector.
    this._detector = new IdleDetector((e) => {
      this.idle = e.type === "idle";
      for (const sink of this._idleSinks) { try { sink(e); } catch {} }
    }, quietMs != null ? { quietMs } : undefined);
    this._pty.attach(this._detector);

    this.exited = this._pty.exited.then((code) => {
      this.exitCode = code;
      return code;
    });
  }

  _append(s) {
    this._scrollback += s;
    if (this._scrollback.length > MAX_SCROLLBACK) {
      this._scrollback = this._scrollback.slice(-MAX_SCROLLBACK);
    }
  }

  /** Current bounded scrollback — replayed to a newly-attached client. */
  snapshot() {
    return this._scrollback;
  }

  /** Write raw bytes to the child's stdin (keystrokes, answers, ^C, …). */
  write(data) {
    try { this._pty.write(data); } catch {}
  }

  resize(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    try { this._pty.resize(cols, rows); } catch {}
  }

  kill(signal) {
    try { this._pty.kill(signal); } catch {}
  }

  /** Subscribe to live output. Returns an unsubscribe fn. */
  onData(sink) {
    this._dataSinks.add(sink);
    return () => this._dataSinks.delete(sink);
  }

  /** Subscribe to idle/active transitions. Returns an unsubscribe fn. */
  onIdle(sink) {
    this._idleSinks.add(sink);
    return () => this._idleSinks.delete(sink);
  }
}

/** Registry of live PTY sessions, keyed by thread id. */
export class PtyManager {
  constructor() {
    /** @type {Map<string, PtySession>} */
    this.sessions = new Map();
  }

  /** Spawn and track a PTY for `id`. Auto-evicts on exit. */
  create(id, opts) {
    const existing = this.sessions.get(id);
    if (existing) existing.kill("SIGKILL");
    const session = new PtySession(id, opts);
    this.sessions.set(id, session);
    session.exited.finally(() => {
      if (this.sessions.get(id) === session) this.sessions.delete(id);
    });
    return session;
  }

  get(id) { return this.sessions.get(id); }
  has(id) { return this.sessions.has(id); }
  list() { return [...this.sessions.values()]; }

  kill(id, signal) {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.kill(signal);
    return true;
  }
}
