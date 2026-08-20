/**
 * Do the app and the bridge still agree about what exists?
 *
 * Pounce ships four independently-versioned things that meet at runtime, and
 * for a long time nothing checked that they fit. The failure mode is always the
 * same and always looks like something else: a client calls a route its bridge
 * has never heard of, the 404 comes back in milliseconds, and whatever screen
 * asked for it reports a network problem. Users see "the machine didn't answer
 * in time" about a machine that answered immediately.
 *
 * This is the release gate for that. It fails the build when:
 *
 *   1. the app calls a route no bridge serves      — the app is ahead of the
 *                                                    bridge, or it's a typo
 *   2. the bridge serves a route nothing declares  — a new route landed without
 *                                                    being added to the feature
 *                                                    manifest, so no client can
 *                                                    gate on it and every old
 *                                                    bridge 404s it silently
 *   3. the manifest declares a route that is gone  — the manifest went stale and
 *                                                    now advertises a promise
 *                                                    the bridge cannot keep
 *
 * (2) is the one that matters. Declaring a route is what makes it visible in
 * /v1/hello, which is what lets a client offer or hide the feature instead of
 * discovering its absence by crashing into it.
 *
 * Deliberately a static check over source rather than a running bridge: it has
 * to work in CI on a machine with no Pounce on it, and it has to fail BEFORE a
 * release is cut rather than after somebody installs one.
 *
 * Usage: node scripts/check-compat.mjs
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { declaredRoutes } from "../apps/bridge/agents/features.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(REPO_ROOT, "apps/bridge/server.mjs");
/** Where clients live. Anything here that names a /v1 route must be servable. */
const CLIENT_DIRS = ["packages/app/src", "desktop/src", "apps/cli/bin"];

/**
 * Routes the bridge actually answers.
 *
 * Read from the `url.pathname === "..."` comparisons rather than from a table
 * the routes are supposed to be registered in, because there is no such table —
 * server.mjs dispatches with a chain of ifs, and a check that trusted a
 * parallel list would be checking the list rather than the server.
 */
function servedRoutes() {
  const src = readFileSync(SERVER, "utf8");
  const found = new Set();
  for (const m of src.matchAll(/url\.pathname === "(\/[^"]+)"/g)) {
    // Only the client API. `/ui`, `/pair`, `/qr.svg` and friends are pages a
    // BROWSER opens, not calls an app makes — nothing gates a feature on them,
    // and requiring them here would be bookkeeping for its own sake.
    if (m[1].startsWith("/v1/")) found.add(m[1]);
  }
  // The health check is answered before the dispatch chain, so it never appears
  // in that form — but every client calls it and it must not read as missing.
  found.add("/health");
  return found;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * Routes a client asks for.
 *
 * Template literals mean a path can be built rather than written (`/v1/thread?
 * id=${id}`), so this takes the literal prefix up to the first interpolation and
 * strips any query string. Test files are skipped: they name routes that are
 * deliberately wrong, which is the point of them.
 */
function calledRoutes() {
  const calls = new Map(); // route -> Set(files)
  for (const rel of CLIENT_DIRS) {
    const dir = path.join(REPO_ROOT, rel);
    let files;
    try {
      files = walk(dir);
    } catch {
      continue; // a client that isn't checked out (CI matrix, sparse clone)
    }
    for (const file of files) {
      if (/\.(test|spec)\./.test(file)) continue;
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/["'`](\/v1\/[a-zA-Z0-9/_-]*)/g)) {
        const route = m[1].replace(/\/$/, "");
        if (!route || route === "/v1") continue;
        if (!calls.has(route)) calls.set(route, new Set());
        calls.get(route).add(path.relative(REPO_ROOT, file));
      }
    }
  }
  return calls;
}

const served = servedRoutes();
const declared = declaredRoutes();
const called = calledRoutes();
const problems = [];

for (const [route, files] of called) {
  if (!served.has(route)) {
    problems.push(
      `a client calls ${route}, which no bridge serves\n` +
        `      ${[...files].join("\n      ")}\n` +
        `      → fix the path, or add the route to apps/bridge/server.mjs`,
    );
  }
}

for (const route of served) {
  if (!declared.has(route)) {
    problems.push(
      `the bridge serves ${route}, which apps/bridge/agents/features.mjs does not declare\n` +
        `      → add it to a feature there, so /v1/hello advertises it and clients\n` +
        `        can gate on it instead of 404ing into it on an older bridge`,
    );
  }
}

for (const route of declared) {
  if (!served.has(route)) {
    problems.push(
      `features.mjs declares ${route}, which the bridge no longer serves\n` +
        `      → remove it, or /v1/hello promises something that isn't there`,
    );
  }
}

if (problems.length) {
  console.error(`\n  app ↔ bridge compatibility: ${problems.length} problem(s)\n`);
  for (const p of problems) console.error(`    ✗ ${p}\n`);
  process.exit(1);
}

console.log(
  `  app ↔ bridge agree: ${served.size} routes served, ` +
    `${declared.size} declared, ${called.size} called by clients`,
);
