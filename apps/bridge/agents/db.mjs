/**
 * The bridge's own database — SQLite, via whichever engine the runtime already
 * has. No dependency, no native addon, no patch.
 *
 * This holds state the bridge OWNS rather than derives from an agent's files:
 * things no transcript on disk records, so losing them loses user intent. It is
 * a real schema rather than a blob, because these same rows are what a future
 * sync layer replicates — every table carries `updated_at` from day one, since
 * a conflict resolver needs it and backfilling it later rewrites every row.
 *
 * WHY NOT TURSO (yet)
 * Turso is the right long-term engine — its offline-sync story is what Phase E
 * wants — but its npm package cannot currently ship inside `bun --compile`,
 * which is how the desktop bridge is distributed:
 *   - the addon resolves through a ~12-platform maze of nested conditional
 *     requires that the bundler cannot statically see through;
 *   - `NAPI_RS_NATIVE_LIBRARY_PATH`, the documented escape hatch, is BROKEN
 *     upstream — `requireNative()` assigns `nativeBinding` then returns
 *     undefined, and the caller clobbers it with that undefined. Verified on
 *     plain Node against a pristine package: setting the variable turns a
 *     working load into "Failed to load native binding";
 *   - and the package throws at module scope when nothing resolves, so a failed
 *     load takes the whole bridge down rather than degrading.
 * Each is fixable only by patching a generated file that changes every release.
 *
 * The SQL here is ordinary SQLite, so adopting Turso later is a driver swap in
 * this one file — not a schema change and not a redesign. When the packaging is
 * fixed upstream (or the DB moves into a Rust sidecar alongside ctx and
 * pounce-tunnel, where Turso is a native crate and none of this applies), only
 * `openEngine` changes.
 *
 * ENGINE BY RUNTIME
 *   compiled bridge / any Bun  → bun:sqlite   (built in)
 *   Node >= 22.5               → node:sqlite  (built in)
 *   Node 20-22.4               → neither; openDb() returns null
 * `engines.node` here is ">=20", so that last row is real: an `npx use-pounce`
 * user can have no SQLite at all. Returning null is a supported state, not an
 * error — callers fall back to the JSON store (see markers.mjs), which is why
 * that path is tested to behave identically.
 */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const DB_DIR = path.join(os.homedir(), ".pounce");
const DB_FILE = path.join(DB_DIR, "bridge.db");

/**
 * Ordered, append-only. Each entry runs once; `user_version` records how far
 * we've got. NEVER edit a shipped migration — add a new one.
 */
const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS markers (
     thread_id  TEXT    NOT NULL,
     event_id   TEXT    NOT NULL,
     marked     INTEGER NOT NULL,
     updated_at TEXT    NOT NULL,
     PRIMARY KEY (thread_id, event_id)
   )`,
  `CREATE INDEX IF NOT EXISTS markers_thread ON markers (thread_id)`,
];

let handle; // undefined = not tried yet, null = no engine on this runtime
let engineName = null;
let lastError = null;

/**
 * Open the engine this runtime provides.
 *
 * require(), not import(): both specifiers are builtins resolved by the RUNTIME,
 * so they survive `bun --compile` (which resolves imports at build time) and
 * throw harmlessly on a runtime that lacks them. Same reasoning as
 * agents/sqlite.mjs, which does this for the read-only adapter path.
 */
function openEngine(file) {
  try {
    const { Database } = require("bun:sqlite");
    engineName = "bun:sqlite";
    return new Database(file);
  } catch {
    // Not Bun — fall through to Node's.
  }
  const { DatabaseSync } = require("node:sqlite"); // throws on Node < 22.5
  engineName = "node:sqlite";
  return new DatabaseSync(file);
}

/**
 * The shared database handle, or null when this runtime has no SQLite. Never
 * throws — an unavailable database must degrade the feature, not take the
 * bridge down.
 */
export function openDb() {
  if (handle !== undefined) return handle;
  handle = null;
  try {
    mkdirSync(DB_DIR, { recursive: true });
    const db = openEngine(DB_FILE);
    db.exec("PRAGMA journal_mode = WAL");
    migrate(db);
    handle = db;
  } catch (err) {
    // Never silent: an unnoticed fallback is how a storage regression ships —
    // reaching straight for node:sqlite is what switched Cursor history off
    // entirely once already.
    lastError = err?.message || String(err);
    console.error(`[db] no SQLite on this runtime, using JSON fallback: ${lastError}`);
  }
  return handle;
}

function migrate(db) {
  const row = db.prepare("PRAGMA user_version").get();
  const at = Number(row?.user_version ?? 0);
  for (let i = at; i < MIGRATIONS.length; i++) db.exec(MIGRATIONS[i]);
  // PRAGMA won't take a bound parameter, and the value is a loop counter we
  // produced ourselves — never user input.
  if (at < MIGRATIONS.length) db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);
}

/** Which engine is live, and why none is. Surfaced by /v1/doctor so a fallback
 *  is visible rather than guessed at. */
export function dbStatus() {
  const db = openDb();
  return { backend: db ? engineName : "json", error: lastError };
}

/** Test seam: drop the memoized handle so a new HOME is picked up. */
export function _reset() {
  handle = undefined;
  engineName = null;
  lastError = null;
}
