/**
 * Client for the bridge's shell terminals (apps/bridge/agents/term.mjs).
 *
 * The bridge runs a real login shell per thread and emulates it, so what
 * arrives here is a painted screen rather than bytes: rows of `[text, fg, bg,
 * flags]` runs, only the ones that changed. This module owns the transport and
 * the key encoding; the dock owns the pixels.
 */
import { bridgeBase, deviceForHost, type BridgeConfig } from "./bridge";
import { streamTurn } from "./streamTurn";

/** One styled span of a row: text, palette fg, palette bg, attribute bits. */
export type Run = [string, number, number, number];

export interface TermLine {
  y: number;
  runs: Run[];
}

export interface TermFrame {
  cols: number;
  rows: number;
  cursor: { row: number; col: number; visible: boolean } | null;
  lines: TermLine[];
  /** True on the first frame of a connection, which carries the WHOLE screen.
   *  Every later frame carries only changed rows and must be merged onto it. */
  first?: boolean;
  exited?: boolean;
}

/** Palette index the bridge uses for "no colour set" — see screen.mjs. */
export const COLOR_DEFAULT = 256;

/** Attribute bits, measured against the emulator (see screen.mjs FLAG). */
export const ATTR = {
  bold: 0x1,
  dim: 0x2,
  italic: 0x4,
  underline: 0x8,
  blink: 0x10,
  inverse: 0x20,
  strike: 0x80,
} as const;

/**
 * Recycle the connection once its buffer passes this.
 *
 * The desktop streaming seam is an XHR whose `responseText` only ever GROWS —
 * fine for a thread list that ends, a slow leak for a terminal left open all
 * day. Reconnecting is free here because the protocol's first frame is a full
 * screen snapshot, so the repaint after a recycle is exactly what's on screen.
 */
const RECYCLE_BYTES = 512 * 1024;

async function cfgFor(hostId: string): Promise<BridgeConfig | null> {
  return (await deviceForHost(hostId)) as BridgeConfig | null;
}

async function post(hostId: string, path: string, body: unknown): Promise<boolean> {
  const cfg = await cfgFor(hostId);
  if (!cfg) return false;
  try {
    const res = await fetch(`${await bridgeBase(cfg)}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Start (or re-attach to) the thread's shell. Idempotent — reopening returns
 * the same session with its scrollback, which is what makes a tab switch feel
 * like coming back rather than starting over.
 *
 * Resolves with the cwd the shell ACTUALLY opened in, which is not always the
 * one asked for: the bridge falls back to the home directory when the path
 * doesn't exist. The dock shows this rather than the request, so a fallback is
 * visible instead of being quietly mislabelled.
 */
export async function openTerm(
  hostId: string,
  id: string,
  opts: { cwd: string | null; cols: number; rows: number },
): Promise<{ ok: boolean; cwd?: string }> {
  const cfg = await cfgFor(hostId);
  if (!cfg) return { ok: false };
  try {
    const res = await fetch(`${await bridgeBase(cfg)}/v1/term/open`, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
      body: JSON.stringify({ id, ...opts }),
    });
    if (!res.ok) return { ok: false };
    return (await res.json()) as { ok: boolean; cwd?: string };
  } catch {
    return { ok: false };
  }
}

export function sendTermInput(hostId: string, id: string, data: string): Promise<boolean> {
  return post(hostId, "/v1/term/input", { id, data });
}

export function resizeTerm(
  hostId: string,
  id: string,
  cols: number,
  rows: number,
): Promise<boolean> {
  return post(hostId, "/v1/term/resize", { id, cols, rows });
}

export function closeTerm(hostId: string, id: string): Promise<boolean> {
  return post(hostId, "/v1/term/close", { id });
}

/**
 * Watch a shell. Calls `onFrame` per frame; returns a stop function.
 *
 * Stopping is cooperative — the seam only notices on the next chunk — but the
 * bridge sends a keepalive comment every 25s, so a silent shell's connection
 * closes within that. The shell itself is unaffected either way: it outlives
 * its watchers by design.
 */
export function streamTerm(
  hostId: string,
  id: string,
  onFrame: (frame: TermFrame) => void,
): () => void {
  let stopped = false;

  const connect = async () => {
    const cfg = await cfgFor(hostId);
    if (!cfg || stopped) return;
    let buf = "";
    let bytes = 0;
    let recycle = false;
    try {
      await streamTurn(
        `${await bridgeBase(cfg)}/v1/term/stream?id=${encodeURIComponent(id)}`,
        { method: "GET", headers: { authorization: `Bearer ${cfg.token}` } },
        (chunk) => {
          if (stopped) return true;
          bytes += chunk.length;
          buf += chunk;
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) !== -1) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const line = frame.split("\n").find((l) => l.startsWith("data:"));
            if (!line) continue; // keepalive comment
            try {
              onFrame(JSON.parse(line.slice(5).trim()) as TermFrame);
            } catch {
              /* a partial frame can't happen — we split on the terminator */
            }
          }
          if (bytes > RECYCLE_BYTES) {
            recycle = true;
            return true;
          }
          return false;
        },
      );
    } catch {
      /* fall through to the retry below */
    }
    if (stopped) return;
    // Recycles reconnect at once; a real failure waits, so a dead bridge isn't
    // hammered by a dock nobody is looking at.
    setTimeout(connect, recycle ? 0 : 1500);
  };

  void connect();
  return () => {
    stopped = true;
  };
}

/**
 * A key press as the bytes a terminal expects.
 *
 * Returns null for keys the text field should handle itself (printable
 * characters arrive via onChangeText, which also covers IME and paste).
 *
 * `appCursor` matters: a TUI that sets application cursor mode expects SS3
 * (`ESC O A`) rather than CSI (`ESC [ A`), and sending the wrong one is why
 * arrow keys silently stop working inside some full-screen programs.
 */
export function encodeKey(
  key: string,
  mods: { ctrl?: boolean; alt?: boolean; shift?: boolean },
  appCursor = false,
): string | null {
  // Ctrl-letter → the C0 control code. Ctrl-C, Ctrl-D, Ctrl-Z and friends are
  // the entire reason a terminal is more useful than a command runner.
  if (mods.ctrl && key.length === 1) {
    const c = key.toLowerCase();
    if (c >= "a" && c <= "z") return String.fromCharCode(c.charCodeAt(0) - 96);
    if (c === "[") return "\x1b";
    if (c === "\\") return "\x1c";
    if (c === "]") return "\x1d";
    if (c === " ") return "\0";
  }
  // Alt-<char> is ESC-prefixed — word-wise movement in readline.
  if (mods.alt && key.length === 1) return `\x1b${key}`;

  const cur = (letter: string) => (appCursor ? `\x1bO${letter}` : `\x1b[${letter}`);
  switch (key) {
    case "Enter":
      return "\r";
    case "Tab":
      return mods.shift ? "\x1b[Z" : "\t";
    case "Backspace":
      return "\x7f";
    case "Delete":
      return "\x1b[3~";
    case "Escape":
      return "\x1b";
    case "ArrowUp":
      return cur("A");
    case "ArrowDown":
      return cur("B");
    case "ArrowRight":
      return cur("C");
    case "ArrowLeft":
      return cur("D");
    case "Home":
      return "\x1b[H";
    case "End":
      return "\x1b[F";
    case "PageUp":
      return "\x1b[5~";
    case "PageDown":
      return "\x1b[6~";
    default:
      return null;
  }
}

/**
 * Merge a delta frame onto the screen we're holding.
 *
 * A `first` frame replaces everything (it IS everything); later frames patch
 * the rows they carry and leave the rest alone. Rows the bridge trimmed to
 * empty still arrive, so a cleared line clears here too.
 */
export function applyFrame(prev: TermLine[], frame: TermFrame): TermLine[] {
  if (frame.first) return frame.lines;
  if (!frame.lines?.length) return prev;
  const next = prev.slice();
  for (const line of frame.lines) {
    const at = next.findIndex((l) => l.y === line.y);
    if (at >= 0) next[at] = line;
    else next.push(line);
  }
  next.sort((a, b) => a.y - b.y);
  return next;
}
