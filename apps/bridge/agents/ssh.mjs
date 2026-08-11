/**
 * Adding a remote machine over SSH.
 *
 * The manual flow already works and is documented: `ssh my-server`, then
 * `npx use-pounce`, then scan the QR that prints in the terminal. This module
 * is that flow with the human steps removed — the desktop app drives the SSH
 * session itself, reads the pairing payload back over the same connection, and
 * hands the caller something it can pass straight to `addDeviceConfig`.
 *
 * SSH is the BOOTSTRAP channel only. Once the remote bridge is up we never
 * speak SSH again: the device is stored with the remote's iroh identity, so the
 * desktop dials it exactly as a scanned QR would — and so does the phone, which
 * can't SSH anywhere. That is the whole reason this beats holding an `ssh -L`
 * open: adding a server on the Mac puts it in your pocket too.
 *
 * The wire format and the argv live in ssh-script.mjs; this half owns the
 * process, the phase machine, and the prompts.
 */
import os from "node:os";
import { PtySession, ptyNative } from "./pty.mjs";
import { agentEnv } from "./env.mjs";
import {
  PHASE_RE,
  detectPrompt,
  namedFailure,
  parseHostName,
  parsePayload,
  sshArgs,
  toDevice,
} from "./ssh-script.mjs";

/** No output at all for this long means something is wedged — a prompt we
 *  failed to recognise, or a network that went away mid-download. */
const IDLE_TIMEOUT_MS = 150_000;
/** Hard ceiling. First runs are genuinely slow: npx fetches the CLI, the CLI
 *  fetches the tunnel binary from GitHub, then waits up to 25s for the tunnel
 *  to come up. Ten minutes is generous on purpose. */
const HARD_TIMEOUT_MS = 10 * 60_000;
/** Transcript kept for parsing and for a client that attaches late. npm's
 *  progress output is long; the markers and the payload are at the end. */
const MAX_TEXT = 256 * 1024;

/** One in-flight bootstrap: the SSH child, what we've learned so far, and the
 *  sinks watching it. Shaped like a term.mjs Shell on purpose — the desktop
 *  already knows how to render one of those. */
class Bootstrap {
  constructor(id, opts) {
    this.id = id;
    this.host = opts.host;
    this.phase = "connecting";
    this.prompt = null;
    this.error = null;
    this.result = null;
    this.startedAt = Date.now();
    this._text = "";
    this._sinks = new Set();

    this.pty = new PtySession(`ssh:${id}`, {
      command: "ssh",
      args: sshArgs(opts),
      env: { ...agentEnv(), TERM: "xterm-256color" },
      cols: 100,
      rows: 30,
    });

    this.pty.onData((chunk) => this._consume(chunk));
    // A prompt is precisely "it printed something, then stopped" — the idle
    // signal the PTY layer already computes for agent CLIs. Reusing it means an
    // unrecognised prompt still stalls visibly instead of silently.
    this.pty.onIdle((e) => {
      if (e.type === "idle") this._detectPrompt();
    });

    this._idleTimer = setTimeout(() => this._timeout(), IDLE_TIMEOUT_MS);
    this._hardTimer = setTimeout(() => this._timeout(), HARD_TIMEOUT_MS);

    this.exited = this.pty.exited.then((code) => {
      this._finish(code);
      return code;
    });
  }

  _consume(chunk) {
    this._text = (this._text + chunk).slice(-MAX_TEXT);

    clearTimeout(this._idleTimer);
    this._idleTimer = setTimeout(() => this._timeout(), IDLE_TIMEOUT_MS);

    let phase = null;
    for (const m of chunk.matchAll(PHASE_RE)) phase = m[1];
    if (phase === "cli-failed") this.error = "`npx use-pounce` failed on that server.";
    else if (phase && phase !== "done") this.phase = phase;

    // Any output at all means whatever we were waiting on has been answered.
    if (this.prompt) this.prompt = null;
    this._emit({ output: chunk });
  }

  _detectPrompt() {
    if (this.prompt || this.result || this.error) return;
    const prompt = detectPrompt(this._text.slice(-400));
    if (!prompt) return;
    this.prompt = prompt;
    this.phase = "prompt";
    this._emit();
  }

  _timeout() {
    if (this.result || this.phase === "failed") return;
    this.error =
      "The server stopped responding. Nothing was added — try again, or run `npx use-pounce` there by hand to see where it stalls.";
    this.phase = "failed";
    this.pty.kill("SIGKILL");
    this._emit();
  }

  /** The child is gone: either we have a payload or we owe an explanation. */
  _finish(code) {
    clearTimeout(this._idleTimer);
    clearTimeout(this._hardTimer);
    if (this.phase === "failed" || this.phase === "done") return;

    const { device, error } = toDevice(parsePayload(this._text), {
      hostName: parseHostName(this._text),
      host: this.host,
    });
    if (device) {
      this.result = device;
      this.phase = "done";
      this.prompt = null;
    } else {
      // Most specific wins: something we can name in the output, then anything
      // the run already concluded (the CLI reporting its own failure), and only
      // then the generic "no payload" or the exit code.
      this.error =
        namedFailure(this._text) || this.error || error || `The SSH session ended (exit ${code}).`;
      this.phase = "failed";
    }
    this._emit();
  }

  state() {
    return {
      id: this.id,
      host: this.host,
      phase: this.phase,
      prompt: this.prompt,
      error: this.error,
      device: this.result,
    };
  }

  /** Answer a prompt. Newline included by the caller — a host-key answer is
   *  "yes\n" and a password is the secret plus a return. */
  write(data) {
    this.pty.write(data);
  }

  cancel() {
    if (this.phase === "done") return;
    this.phase = "failed";
    this.error ||= "Cancelled.";
    this.pty.kill("SIGKILL");
    this._emit();
  }

  attach(sink) {
    this._sinks.add(sink);
    return () => this._sinks.delete(sink);
  }

  /** Transcript so far, replayed to a client that attaches mid-run. */
  snapshot() {
    return this._text;
  }

  _emit(extra) {
    const msg = { ...this.state(), ...extra };
    for (const sink of this._sinks) {
      try {
        sink(msg);
      } catch {}
    }
  }
}

/** @type {Map<string, Bootstrap>} */
const runs = new Map();

/** Start a bootstrap. Returns the run, whose id addresses it in /v1/ssh/*. */
export function startSshBootstrap({
  host,
  user = null,
  sshPort = null,
  bridgePort = 8099,
  strictHostKey = true,
}) {
  if (!host) throw new Error("host required");
  // Without a real TTY ssh cannot prompt, so a password-auth host would hang
  // with no way to answer it. Say so now rather than at minute three.
  if (!ptyNative) {
    throw new Error("this machine has no PTY support, so it can't run an interactive SSH session");
  }
  const id = `ssh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const run = new Bootstrap(id, { host, user, sshPort, bridgePort, strictHostKey });
  runs.set(id, run);
  // Kept briefly after exit so a client that polls late gets the outcome
  // instead of a 404.
  run.exited.finally(() => setTimeout(() => runs.delete(id), 60_000).unref?.());
  return run;
}

export function getSshBootstrap(id) {
  return runs.get(id) ?? null;
}

export function cancelSshBootstrap(id) {
  const run = runs.get(id);
  if (!run) return false;
  run.cancel();
  return true;
}

/** Kill everything in flight — called when the bridge shuts down. */
export function killAllSshBootstraps() {
  for (const run of runs.values()) run.cancel();
  runs.clear();
}

/** Default user, for prefilling the form. */
export function defaultSshUser() {
  return os.userInfo().username;
}
