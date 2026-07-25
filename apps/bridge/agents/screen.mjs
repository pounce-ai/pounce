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

/** Reverse-video bit in a cell's `flags` (empirically 0x20 in wterm's core) —
 *  TUIs highlight the active menu row with it. */
const FLAG_INVERSE = 0x20;

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

  dispose() {
    this._bridge = null;
  }
}
