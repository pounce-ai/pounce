/**
 * SessionIndex — a memory-disciplined catalog of on-disk agent sessions.
 *
 * Holds ONLY lightweight metadata (~300 bytes/thread: id, filePath, cwd, title,
 * preview, timestamps) in a Map; message bodies are never retained here. Boot
 * does one walk of the roots with a bounded head-read per file (the adapter's
 * `scanFile`), then fs.watch keeps the index current incrementally — on a file
 * event we re-stat/re-scan just that file, so the index can't fall behind the
 * way the old daemon's did (no rescans, no polling, no restart-to-reindex).
 */
import { readdirSync, statSync, watch } from "node:fs";
import path from "node:path";

export class SessionIndex {
  /**
   * @param {object} opts
   * @param {string} opts.root       directory to walk/watch (may not exist yet)
   * @param {(name: string) => boolean} opts.match  filename filter (e.g. *.jsonl)
   * @param {(filePath: string, stat: import('node:fs').Stats) => Promise<object|null>} opts.scanFile
   *   extract a meta ({id, ...}) from one file; null to exclude it
   * @param {number} [opts.debounceMs]
   */
  constructor({ root, match, scanFile, debounceMs = 250 }) {
    this.root = root;
    this.match = match;
    this.scanFile = scanFile;
    this.debounceMs = debounceMs;
    this.metas = new Map(); // id -> meta
    this.byPath = new Map(); // filePath -> id
    this._ready = null;
    this._watchers = [];
    this._timers = new Map(); // filePath -> debounce timer
    this._dirty = new Set(); // onDirty callbacks
  }

  /** Register a callback fired with a thread id whose file changed/vanished. */
  onDirty(cb) { this._dirty.add(cb); }

  /** First call walks + watches; later calls are free. Never rejects. */
  ensure() {
    if (!this._ready) this._ready = this._scanAll().then(() => this._watch()).catch(() => {});
    return this._ready;
  }

  /** All metas, newest activity first. */
  async list() {
    await this.ensure();
    return [...this.metas.values()].sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  }

  async get(id) {
    await this.ensure();
    return this.metas.get(id) || null;
  }

  async _scanAll() {
    for (const file of walkFiles(this.root, this.match)) {
      await this._scanOne(file);
    }
  }

  async _scanOne(filePath) {
    let st;
    try { st = statSync(filePath); } catch { return this._drop(filePath); }
    if (!st.isFile()) return;
    let meta = null;
    try { meta = await this.scanFile(filePath, st); } catch {}
    if (!meta || !meta.id) return;
    // The same file may have produced a meta before — keep the id↔path maps consistent.
    const prevId = this.byPath.get(filePath);
    if (prevId && prevId !== meta.id) this.metas.delete(prevId);
    this.byPath.set(filePath, meta.id);
    this.metas.set(meta.id, meta);
  }

  _drop(filePath) {
    const id = this.byPath.get(filePath);
    if (!id) return;
    this.byPath.delete(filePath);
    this.metas.delete(id);
    this._emit(id);
  }

  _emit(id) { for (const cb of this._dirty) { try { cb(id); } catch {} } }

  _onFsEvent(relName) {
    if (!relName) return; // platform gave no filename — ignore rather than rescan
    const full = path.join(this.root, relName);
    if (!this.match(path.basename(full))) return;
    // Debounce per file: agents append transcripts in bursts.
    clearTimeout(this._timers.get(full));
    this._timers.set(full, setTimeout(() => {
      this._timers.delete(full);
      void this._scanOne(full).then(() => {
        const id = this.byPath.get(full);
        if (id) this._emit(id);
      });
    }, this.debounceMs));
  }

  _watch() {
    // Recursive fs.watch is native on macOS/Windows and supported by Node ≥20
    // on Linux; if it throws we fall back to watching each first-level subdir
    // (covers Claude's projects/<dir>/*.jsonl layout; new subdirs are picked up
    // by the root watcher).
    try {
      this._watchers.push(watch(this.root, { recursive: true }, (_e, f) => this._onFsEvent(f)));
      return;
    } catch {}
    try {
      const watchDir = (dir, prefix) => {
        try {
          this._watchers.push(watch(dir, (_e, f) => f && this._onFsEvent(path.join(prefix, f))));
        } catch {}
      };
      watchDir(this.root, "");
      for (const d of readdirSync(this.root, { withFileTypes: true })) {
        if (d.isDirectory()) watchDir(path.join(this.root, d.name), d.name);
      }
      // New first-level dirs after boot: re-attach when the root reports them.
      this._watchers.push(watch(this.root, (_e, f) => {
        if (!f) return;
        const full = path.join(this.root, f);
        try { if (statSync(full).isDirectory()) watchDir(full, f); } catch {}
      }));
    } catch {}
  }

  close() {
    for (const w of this._watchers) { try { w.close(); } catch {} }
    for (const t of this._timers.values()) clearTimeout(t);
    this._watchers = [];
    this._timers.clear();
  }
}

/** Depth-first file walk (sync — runs once at boot over a few hundred entries). */
function* walkFiles(root, match, depth = 0) {
  if (depth > 6) return; // safety bound; session trees are ≤4 deep
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) yield* walkFiles(full, match, depth + 1);
    else if (e.isFile() && match(e.name)) yield full;
  }
}
