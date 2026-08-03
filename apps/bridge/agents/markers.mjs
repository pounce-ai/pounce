/**
 * Markers — the user's jump-to points inside a thread.
 *
 * The app computes a DEFAULT for every event (prose user messages and any
 * interactive prompt are marked; see `defaultMarked` in the app's stores), and
 * what is stored is only the deviations from that default. So a row here means
 * "the user explicitly marked something the default would skip, or unmarked
 * something the default would mark" — never the full set. Keeping it sparse is
 * what makes this hundreds of rows instead of one per message.
 *
 * These lived only in the app's MMKV collection, which made them invisible to
 * the bridge: a second device saw nothing, and nothing outside the app (the MCP
 * server, say) could answer "what did I flag in this thread?". The bridge is the
 * natural owner — it already knows every thread on the machine.
 *
 * Rows carry `updated_at` because that is what a sync layer resolves conflicts
 * on. Nothing reads it yet; it exists so the column doesn't have to be
 * backfilled across every row later.
 *
 * Storage is the SQLite schema in db.mjs, falling back to a JSON store on
 * runtimes with no SQLite at all (Node 20-22.4, which `engines.node: ">=20"`
 * still admits). The fallback is a supported state, not an error path —
 * `backend()` reports which is live and both are tested to behave identically.
 */
import { dbStatus, openDb } from "./db.mjs";
import { Store } from "./store.mjs";

/** Fallback only — keyed `<threadId>|<eventId>`, matching the app's collection. */
const fallback = new Store("markers");
const now = () => new Date().toISOString();

/** Which backend is live: the runtime's SQLite engine, or "json". */
export async function backend() {
  return dbStatus().backend;
}

function parseKey(key) {
  const i = key.indexOf("|");
  return i < 0 ? null : { threadId: key.slice(0, i), eventId: key.slice(i + 1) };
}

/**
 * Overrides as a flat list — the shape the MCP server and any non-app consumer
 * wants ("which messages did I flag?"). Omit `threadId` for every thread.
 */
export async function listMarkers(threadId) {
  const db = openDb();
  if (db) {
    const rows = threadId
      ? db
          .prepare(
            "SELECT thread_id, event_id, marked FROM markers WHERE thread_id = ? ORDER BY rowid",
          )
          .all(threadId)
      : db.prepare("SELECT thread_id, event_id, marked FROM markers ORDER BY rowid").all();
    return rows.map((r) => ({
      threadId: r.thread_id,
      eventId: r.event_id,
      marked: !!r.marked,
    }));
  }
  const src = threadId ? fallback.withPrefix(`${threadId}|`) : fallback.all();
  const out = [];
  for (const [key, val] of Object.entries(src)) {
    const parts = parseKey(key);
    if (parts) out.push({ ...parts, marked: !!val?.marked });
  }
  return out;
}

/**
 * Record an override. `marked` is the user's explicit choice; null clears the
 * override so the event falls back to the computed default — which is exactly
 * what the app does when a toggle lands back on the default.
 */
export async function setMarker(threadId, eventId, marked) {
  if (!threadId || !eventId) return false;
  const db = openDb();
  if (db) {
    if (marked === null || marked === undefined) {
      db.prepare("DELETE FROM markers WHERE thread_id = ? AND event_id = ?").run(threadId, eventId);
      return true;
    }
    db.prepare(
      `INSERT INTO markers (thread_id, event_id, marked, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (thread_id, event_id)
         DO UPDATE SET marked = excluded.marked, updated_at = excluded.updated_at`,
    ).run(threadId, eventId, marked ? 1 : 0, now());
    return true;
  }
  const key = `${threadId}|${eventId}`;
  if (marked === null || marked === undefined) return fallback.delete(key);
  fallback.set(key, { marked: !!marked, updatedAt: now() });
  return true;
}

/** Drop every override for a thread — used when a thread is deleted. */
export async function clearThreadMarkers(threadId) {
  if (!threadId) return 0;
  const db = openDb();
  if (db) {
    const before = countFor(db, threadId);
    db.prepare("DELETE FROM markers WHERE thread_id = ?").run(threadId);
    return before;
  }
  return fallback.deletePrefix(`${threadId}|`);
}

function countFor(db, threadId) {
  const rows = db.prepare("SELECT COUNT(*) AS n FROM markers WHERE thread_id = ?").all(threadId);
  return Number(rows[0]?.n ?? 0);
}

/**
 * Replace this thread's overrides with exactly `rows` ([{eventId, marked}]).
 * The app owns the full set for a thread it has open, so a sync pushes the whole
 * thread rather than diffing — simpler and idempotent. Transactional so
 * a failure mid-write can't leave the thread half-replaced.
 */
export async function replaceThreadMarkers(threadId, rows) {
  if (!threadId || !Array.isArray(rows)) return 0;
  const valid = rows.filter((r) => r?.eventId);
  const db = openDb();
  if (db) {
    const stamp = now();
    db.exec("BEGIN");
    try {
      db.prepare("DELETE FROM markers WHERE thread_id = ?").run(threadId);
      const ins = db.prepare(
        "INSERT INTO markers (thread_id, event_id, marked, updated_at) VALUES (?, ?, ?, ?)",
      );
      for (const r of valid) ins.run(threadId, r.eventId, r.marked ? 1 : 0, stamp);
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw err;
    }
    return valid.length;
  }
  fallback.deletePrefix(`${threadId}|`);
  const stamp = now();
  for (const r of valid) {
    fallback.set(`${threadId}|${r.eventId}`, { marked: !!r.marked, updatedAt: stamp });
  }
  return valid.length;
}

/** Test seam. */
export const _fallback = fallback;
