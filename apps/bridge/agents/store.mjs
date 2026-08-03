/**
 * Durable key-value store for the bridge's own state — the small set of facts
 * the bridge owns rather than derives from an agent's files on disk.
 *
 * Deliberately NOT SQLite, for the reason cost-ledger.mjs already records: this
 * repo's `engines.node` is ">=20" but `node:sqlite` only exists from Node 22.5,
 * so an `npx use-pounce` user on Node 20 has no SQLite at all (openSqliteReadOnly
 * returns null). Making the bridge's own state SQLite-only would silently lose
 * it for those users — the same class of failure that switched Cursor history
 * off entirely when adapters reached straight for `node:sqlite`. What is stored
 * here is hundreds of rows of flat key/value, not something needing a query
 * planner; the benchmark that motivated this put a 55KB JSON load at 0.11ms.
 *
 * One JSON file per namespace under ~/.pounce/state/, written through on every
 * mutation by atomic rename, so a crash mid-write leaves the previous file
 * intact and a shutdown can't drop a just-accepted write.
 *
 * If this ever needs real queries or cross-device sync, this file is the only
 * thing that changes — callers see a Map-like surface and nothing else.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const STATE_DIR = path.join(os.homedir(), ".pounce", "state");

export class Store {
  /** @param {string} name  namespace → ~/.pounce/state/<name>.json */
  constructor(name) {
    this.file = path.join(STATE_DIR, `${name}.json`);
    this.rows = new Map();
    this._loaded = false;
  }

  _load() {
    if (this._loaded) return;
    this._loaded = true;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8"));
      if (raw && typeof raw === "object" && raw.rows && typeof raw.rows === "object") {
        for (const [k, v] of Object.entries(raw.rows)) this.rows.set(k, v);
      }
    } catch {
      // Absent or torn — start empty rather than failing the bridge's boot.
    }
  }

  get(key) {
    this._load();
    return this.rows.get(key);
  }

  has(key) {
    this._load();
    return this.rows.has(key);
  }

  /** All entries as a plain object — the wire shape for the HTTP layer. */
  all() {
    this._load();
    return Object.fromEntries(this.rows);
  }

  /** Entries whose key starts with `prefix`, as a plain object. */
  withPrefix(prefix) {
    this._load();
    const out = {};
    for (const [k, v] of this.rows) if (k.startsWith(prefix)) out[k] = v;
    return out;
  }

  set(key, value) {
    this._load();
    this.rows.set(key, value);
    this._schedule();
  }

  delete(key) {
    this._load();
    const had = this.rows.delete(key);
    if (had) this._schedule();
    return had;
  }

  /** Drop every key starting with `prefix`. Returns how many went. */
  deletePrefix(prefix) {
    this._load();
    let n = 0;
    for (const k of [...this.rows.keys()]) {
      if (k.startsWith(prefix) && this.rows.delete(k)) n++;
    }
    if (n) this._schedule();
    return n;
  }

  /**
   * Write immediately.
   *
   * This used to coalesce on a 250ms unref'd timer, which lost writes outright
   * whenever the process exited inside the window — a marker POST followed by a
   * shutdown left the file absent, and exit/SIGTERM hooks did not reliably save
   * it either. These files are a few hundred rows (55KB parses in 0.11ms here)
   * and the writes happen at human speed, so the timer was buying nothing and
   * costing durability. Write-through is simply correct.
   */
  _schedule() {
    this.flush();
  }

  /** Write now. Safe to call at any time; kept public for tests. */
  flush() {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ v: 1, rows: Object.fromEntries(this.rows) }));
      renameSync(tmp, this.file);
    } catch {
      // Losing a write is survivable (markers are an override layer over a
      // computed default); crashing the bridge over it is not.
    }
  }
}
