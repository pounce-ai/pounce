/**
 * A headless terminal screen for a PTY session — the substrate for GENERIC,
 * agent-agnostic prompt detection.
 *
 * The bespoke path read an AskUserQuestion tool-call out of claude's transcript,
 * so trust / permission / plan-mode prompts (which never touch the transcript)
 * were invisible and blocked forever. Instead we feed the PTY's raw bytes into a
 * headless VT emulator and read the RENDERED screen. Any CLI's on-screen menu —
 * whatever the agent, whatever the prompt — then looks the same: rows of text,
 * one row highlighted. See prompt-detect.mjs.
 *
 * Backend: @wterm/core's WasmBridge — a ~12 KB Zig/WASM VT state machine, fully
 * headless (no DOM), no native binary to code-sign (unlike a libvterm/Ghostty
 * N-API build). Its `getCell` exposes the reverse-video flag we use as the
 * highlight signal, and the same `TerminalCore` interface can be upgraded to
 * libghostty (@wterm/ghostty) later without touching this file.
 */
import { WasmBridge } from "@wterm/core";

/**
 * Cell attribute bits, measured against @wterm/core rather than assumed — every
 * one of these was read back out of the WASM after writing the matching SGR.
 *
 * 0x40 is unaccounted for (probably "hidden"); nothing here needs it, and a bit
 * we haven't confirmed the meaning of is one we shouldn't be rendering.
 */
export const FLAG = {
  bold: 0x1,
  dim: 0x2,
  italic: 0x4,
  underline: 0x8,
  blink: 0x10,
  inverse: 0x20,
  strike: 0x80,
};

/** TUIs highlight the active menu row with reverse video — the signal
 *  prompt-detect.mjs keys on. */
const FLAG_INVERSE = FLAG.inverse;

/**
 * The palette index this core uses for "no colour set".
 *
 * 256 rather than -1, which matters: a client that treats it as an index reads
 * the default foreground as an out-of-range colour and paints nothing.
 *
 * Note that truecolor is NOT preserved. `CellData` declares optional `fgRgb`/
 * `bgRgb`, but this WASM core never populates them — it quantizes 24-bit SGR
 * into the 256-colour cube (measured: `38;2;10;20;30` arrives as index 17). So
 * the wire format is palette-only by nature, not by choice. Swapping the core
 * for @wterm/ghostty later is where true colour would come from; this file's
 * shape wouldn't have to change.
 */
export const COLOR_DEFAULT = 256;

export class Screen {
  constructor({ cols = 120, rows = 40 } = {}) {
    this._cols = cols;
    this._rows = rows;
    this._bridge = null;
    this._pending = []; // bytes that arrive before the WASM finishes loading
    // WasmBridge.load() is async; PtySession constructs (and starts streaming)
    // synchronously, so buffer until ready, then replay in order. Loads in ~ms —
    // long before any prompt could appear.
    WasmBridge.load()
      .then((b) => {
        b.init(this._cols, this._rows);
        for (const d of this._pending) {
          try {
            b.writeString(d);
          } catch {}
        }
        this._pending = null;
        this._bridge = b;
      })
      .catch(() => {
        this._pending = null;
      }); // degrade to "no detection" if WASM won't load
  }

  write(data) {
    if (this._bridge) {
      try {
        this._bridge.writeString(data);
      } catch {}
    } else if (this._pending) this._pending.push(data);
  }

  resize(cols, rows) {
    this._cols = cols;
    this._rows = rows;
    if (this._bridge) {
      try {
        this._bridge.resize(cols, rows);
      } catch {}
    }
  }

  /**
   * The rendered visible screen as rows of `{ text, inverse }`, top to bottom.
   * `inverse` is true when the row carries reverse video (the highlight). Empty
   * before the WASM loads (→ no detection, which is the safe default).
   */
  lines() {
    const b = this._bridge;
    if (!b) return [];
    const cols = b.getCols();
    const rows = b.getRows();
    const out = [];
    for (let r = 0; r < rows; r++) {
      let text = "";
      let inverse = false;
      for (let c = 0; c < cols; c++) {
        const cell = b.getCell(r, c);
        const cp = cell?.char || 0;
        const ch = cp >= 32 ? String.fromCodePoint(cp) : " ";
        text += ch;
        if (ch !== " " && cell.flags & FLAG_INVERSE) inverse = true;
      }
      out.push({ text: text.replace(/\s+$/u, ""), inverse });
    }
    return out;
  }

  /**
   * The visible screen as coloured RUNS — what the terminal dock renders.
   *
   * Runs, not cells: a row is 120 cells but usually only a handful of colour
   * changes, and one object per cell would put ~10x the bytes on the wire and
   * ~10x the elements on screen for the same picture. Adjacent cells sharing
   * every attribute collapse into one `[text, fg, bg, flags]` tuple — a tuple
   * rather than an object for the same reason, since these are the highest-
   * frequency payload the bridge sends.
   *
   * `dirtyOnly` returns only the rows that changed since the last call and
   * clears the dirty marks, which is what makes streaming cheap: a shell
   * printing one line re-sends one row, not the whole screen. The caller must
   * therefore be the ONLY reader — two consumers calling this would each see
   * half the updates. (The full screen is always available with `dirtyOnly`
   * false, which is what a newly-attached client asks for.)
   *
   * Empty rows before the WASM loads, same as lines().
   */
  cells({ dirtyOnly = false } = {}) {
    const b = this._bridge;
    if (!b) return { cols: this._cols, rows: this._rows, cursor: null, lines: [] };
    const cols = b.getCols();
    const rowCount = b.getRows();
    const out = [];
    for (let y = 0; y < rowCount; y++) {
      if (dirtyOnly && !b.isDirtyRow(y)) continue;
      const runs = [];
      let text = "";
      let fg = -1;
      let bg = -1;
      let flags = -1;
      for (let x = 0; x < cols; x++) {
        const cell = b.getCell(y, x);
        const cp = cell?.char || 0;
        // Control codes never reach a cell as glyphs; anything under 0x20 here
        // is an empty cell, which is a space.
        const ch = cp >= 32 ? String.fromCodePoint(cp) : " ";
        const cf = cell?.fg ?? COLOR_DEFAULT;
        const cb = cell?.bg ?? COLOR_DEFAULT;
        const fl = cell?.flags ?? 0;
        if (cf !== fg || cb !== bg || fl !== flags) {
          if (text) runs.push([text, fg, bg, flags]);
          text = "";
          fg = cf;
          bg = cb;
          flags = fl;
        }
        text += ch;
      }
      if (text) runs.push([text, fg, bg, flags]);
      // Trailing blanks are the unused rest of the line and carry no
      // information — drop them rather than shipping 100 spaces per row. Only
      // where the background is DEFAULT: a run of spaces on a coloured
      // background is a drawn block (a selection bar, a TUI panel edge), and
      // trimming that would punch a hole in the picture.
      while (runs.length) {
        const last = runs[runs.length - 1];
        if (last[2] !== COLOR_DEFAULT) break;
        // The blanks can share a run with real text ("done" + padding), so trim
        // within the run before deciding whether the run itself can go.
        const trimmed = last[0].replace(/ +$/u, "");
        if (trimmed === last[0]) break;
        if (trimmed) {
          runs[runs.length - 1] = [trimmed, last[1], last[2], last[3]];
          break;
        }
        runs.pop();
      }
      out.push({ y, runs });
    }
    if (dirtyOnly) b.clearDirty();
    let cursor = null;
    try {
      cursor = b.getCursor();
    } catch {}
    return { cols, rows: rowCount, cursor, lines: out };
  }

  /**
   * The terminal's own reply to a query the program made (DA, DSR, cursor
   * position…), which the caller must write back to the PTY.
   *
   * Without this a program that asks "what terminal are you?" waits forever for
   * an answer nobody sends — which is how a shell ends up hanging on startup
   * rather than showing a prompt.
   */
  takeResponse() {
    try {
      return this._bridge?.getResponse() || null;
    } catch {
      return null;
    }
  }

  /** Whether the program has switched to the alternate screen (vim, less…).
   *  The dock uses it to suppress its own scrollback handling. */
  altScreen() {
    try {
      return !!this._bridge?.usingAltScreen();
    } catch {
      return false;
    }
  }

  /** Whether the cursor keys should send application-mode sequences (SS3) —
   *  a TUI that turns this on stops responding to plain arrow keys otherwise. */
  cursorKeysApp() {
    try {
      return !!this._bridge?.cursorKeysApp();
    } catch {
      return false;
    }
  }

  /** The title the program set via OSC 0/2, if any. */
  title() {
    try {
      return this._bridge?.getTitle() || null;
    } catch {
      return null;
    }
  }

  dispose() {
    this._bridge = null;
  }
}
