/**
 * SessionIndex — a memory-disciplined catalog of on-disk agent sessions.
 *
 * Holds ONLY lightweight metadata (~300 bytes/thread: id, filePath, cwd, title,
 * preview, timestamps) in a Map; message bodies are never retained here. Boot
 * does one walk of the roots with a bounded head-read per file (the adapter's
 * `scanFile`), then fs.watch keeps the index current incrementally — on a file
 * event we re-stat/re-scan just that file, so the index can't fall behind the
 * way the old daemon's did (no rescans, no polling, no restart-to-reindex).
 *
 * Adapters that pass `cacheName` also get a warm-start snapshot on disk, so a
 * restart re-stats the tree instead of re-reading every transcript in it.
 */
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  watch,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const CACHE_DIR = path.join(os.homedir(), ".pounce", "index");

/** BUMP THIS whenever an adapter's `scanFile` changes the shape of a meta.
 *  Snapshots are keyed on file mtime+size, so without a version an upgraded
 *  bridge would happily serve metas built by the previous one forever. */
const SNAPSHOT_VERSION = 1;

export class SessionIndex {
  /**
   * @param {object} opts
   * @param {string} opts.root       directory to walk/watch (may not exist yet)
   * @param {(name: string) => boolean} opts.match  filename filter (e.g. *.jsonl)
   * @param {(filePath: string, stat: import('node:fs').Stats) => Promise<object|null>} opts.scanFile
   *   extract a meta ({id, ...}) from one file; null to exclude it
   * @param {number} [opts.debounceMs]
   */
  constructor({ root, match, scanFile, debounceMs = 250, cacheName = null }) {
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
    // Warm-start snapshot. Without one, every boot re-head-reads every
    // transcript on disk: 682ms for 131 claude threads here, against 0.1ms once
    // the index is warm. Opt-in by name so each adapter gets its own file.
    this._cacheFile = cacheName ? path.join(CACHE_DIR, `${cacheName}.json`) : null;
    this._stamps = new Map(); // filePath -> "mtimeMs:size" as last scanned
    this._dirtySinceSave = false;
  }

  /** Register a callback fired with a thread id whose file changed/vanished. */
  onDirty(cb) {
    this._dirty.add(cb);
  }

  /** First call walks + watches; later calls are free. Never rejects. */
  ensure() {
    if (!this._ready)
      this._ready = Promise.resolve()
        .then(() => this._loadSnapshot())
        .then(() => this._scanAll())
        .then(() => {
          this._watch();
          this._saveSnapshot();
        })
        .catch(() => {});
    return this._ready;
  }

  /** Seed metas from the last run. Entries are trusted only as far as the
   *  stamp check in `_scanOne` — a file that changed while we were down is
   *  re-scanned, and one that vanished is dropped by the walk. */
  _loadSnapshot() {
    if (!this._cacheFile) return;
    let snap;
    try {
      snap = JSON.parse(readFileSync(this._cacheFile, "utf8"));
    } catch {
      return; // absent or torn — a full walk rebuilds it
    }
    if (snap?.v !== SNAPSHOT_VERSION || snap.root !== this.root) return;
    if (!Array.isArray(snap.entries)) return;
    for (const e of snap.entries) {
      if (!e?.filePath || !e.stamp) continue;
      this._stamps.set(e.filePath, e.stamp);
      if (!e.meta?.id) continue; // stamp-only: a file we read and rejected
      this.metas.set(e.meta.id, e.meta);
      this.byPath.set(e.filePath, e.meta.id);
    }
  }

  _saveSnapshot() {
    if (!this._cacheFile || !this._dirtySinceSave) return;
    this._dirtySinceSave = false;
    // Every stamped file, indexed or not — a meta-less entry records "we read
    // this and it isn't a session", which is just as expensive to rediscover.
    const entries = [];
    for (const [filePath, stamp] of this._stamps) {
      const id = this.byPath.get(filePath);
      const meta = id ? this.metas.get(id) : null;
      entries.push(meta ? { filePath, stamp, meta } : { filePath, stamp });
    }
    try {
      mkdirSync(path.dirname(this._cacheFile), { recursive: true });
      const tmp = `${this._cacheFile}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ v: SNAPSHOT_VERSION, root: this.root, entries }));
      renameSync(tmp, this._cacheFile); // atomic — a crash costs one cold walk
    } catch {}
  }

  /** All metas, newest activity first. */
  async list() {
    await this.ensure();
    return [...this.metas.values()].sort((a, b) =>
      (b.updatedAt || "").localeCompare(a.updatedAt || ""),
    );
  }

  async get(id) {
    await this.ensure();
    return this.metas.get(id) || null;
  }

  /** Bounded-concurrency walk: each file is a stat plus (on a miss) a head-read,
   *  so the serial version spent most of its time waiting on I/O. */
  async _scanAll() {
    const files = [...walkFiles(this.root, this.match)];
    const seen = new Set(files);
    const q = files.slice();
    await Promise.all(
      Array.from({ length: Math.min(12, q.length) }, async () => {
        while (q.length) await this._scanOne(q.shift());
      }),
    );
    // Anything the snapshot knew about that is no longer on disk was deleted
    // while we were down. Covers stamp-only entries too, so the file can't grow
    // without bound as transcripts come and go.
    for (const filePath of [...this._stamps.keys()]) {
      if (seen.has(filePath)) continue;
      if (this.byPath.has(filePath)) this._drop(filePath);
      else {
        this._stamps.delete(filePath);
        this._dirtySinceSave = true;
      }
    }
  }

  async _scanOne(filePath) {
    let st;
    try {
      st = statSync(filePath);
    } catch {
      return this._drop(filePath);
    }
    if (!st.isFile()) return;
    // Unchanged since we last scanned it (same mtime AND size) — re-reading its
    // head would tell us exactly what we already know.
    //
    // Stamps cover files the scan REJECTED as well as ones it indexed: this
    // tree holds 338 .jsonl files for 131 threads, so stamping only the
    // successes left 207 files being re-read on every single boot.
    const stamp = `${st.mtimeMs}:${st.size}`;
    if (this._stamps.get(filePath) === stamp) {
      const knownId = this.byPath.get(filePath);
      if (!knownId || this.metas.has(knownId)) return; // indexed, or known-excluded
    }

    let meta = null;
    try {
      meta = await this.scanFile(filePath, st);
    } catch {}
    if (!meta || !meta.id) {
      // Remember the rejection so the next boot skips it too.
      this._stamps.set(filePath, stamp);
      this._dirtySinceSave = true;
      return;
    }
    // The same file may have produced a meta before — keep the id↔path maps consistent.
    const prevId = this.byPath.get(filePath);
    if (prevId && prevId !== meta.id) this.metas.delete(prevId);
    this.byPath.set(filePath, meta.id);
    this.metas.set(meta.id, meta);
    this._stamps.set(filePath, stamp);
    this._dirtySinceSave = true;
  }

  _drop(filePath) {
    const id = this.byPath.get(filePath);
    if (!id) return;
    this.byPath.delete(filePath);
    this.metas.delete(id);
    this._stamps.delete(filePath);
    this._dirtySinceSave = true;
    this._emit(id);
  }

  _emit(id) {
    for (const cb of this._dirty) {
      try {
        cb(id);
      } catch {}
    }
  }

  _onFsEvent(relName) {
    if (!relName) return; // platform gave no filename — ignore rather than rescan
    const full = path.join(this.root, relName);
    if (!this.match(path.basename(full))) return;
    // Debounce per file: agents append transcripts in bursts.
    clearTimeout(this._timers.get(full));
    this._timers.set(
      full,
      setTimeout(() => {
        this._timers.delete(full);
        void this._scanOne(full).then(() => {
          const id = this.byPath.get(full);
          if (id) this._emit(id);
          this._saveSnapshot();
        });
      }, this.debounceMs),
    );
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
      this._watchers.push(
        watch(this.root, (_e, f) => {
          if (!f) return;
          const full = path.join(this.root, f);
          try {
            if (statSync(full).isDirectory()) watchDir(full, f);
          } catch {}
        }),
      );
    } catch {}
  }

  close() {
    for (const w of this._watchers) {
      try {
        w.close();
      } catch {}
    }
    for (const t of this._timers.values()) clearTimeout(t);
    this._watchers = [];
    this._timers.clear();
  }
}

/** Depth-first file walk (sync — runs once at boot over a few hundred entries). */
function* walkFiles(root, match, depth = 0) {
  if (depth > 6) return; // safety bound; session trees are ≤4 deep
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) yield* walkFiles(full, match, depth + 1);
    else if (e.isFile() && match(e.name)) yield full;
  }
}
