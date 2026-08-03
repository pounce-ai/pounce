/**
 * Open a SQLite file read-only on whichever runtime we're on.
 *
 * The bridge runs under Node in dev and under Bun in the shipped desktop app
 * (`bun --compile` — see scripts/bridge/compile.mjs). Bun has NO `node:sqlite`;
 * it ships `bun:sqlite` instead. Adapters that reached straight for
 * `node:sqlite` therefore worked in dev and silently degraded in the product:
 * opencode fell back to its legacy JSON store and showed a handful of
 * years-old sessions, and Cursor history switched off entirely.
 *
 * Both modules expose the same shape for what the adapters need —
 * `prepare(sql).all(...)` / `.get(...)` / `close()` — so callers need no fork
 * beyond this function. Only the read-only option differs in spelling.
 */
import { createRequire } from "node:module";

const nodeRequire = createRequire(import.meta.url);

/** A read-only handle, or null when neither module is available. */
export function openSqliteReadOnly(file) {
  // node:sqlite first: it's the native path in dev and under a plain Node host.
  // createRequire rather than import() because vite-node rewrites a bare
  // dynamic import of a builtin during tests (the reason cursor.mjs already
  // did this).
  try {
    const { DatabaseSync } = nodeRequire("node:sqlite");
    return new DatabaseSync(file, { readOnly: true });
  } catch {
    // Not Node, or too old for node:sqlite — try Bun.
  }
  try {
    // require(), not import(): `bun --compile` resolves imports at BUILD time,
    // and a dynamic import whose specifier is a variable is simply absent from
    // the produced binary — which is the environment this exists for. A
    // require of a builtin is resolved by the runtime, so it survives the
    // bundler and still throws harmlessly under Node.
    const { Database } = nodeRequire("bun:sqlite");
    return new Database(file, { readonly: true });
  } catch {
    return null;
  }
}
