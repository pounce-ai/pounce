/**
 * User overrides for custom setups — persisted at ~/.pounce/config.json.
 *
 * Auto-detection (PATH + our extra install dirs) covers the common case, but a
 * custom setup can defeat it: a `codex` shadowed by a corporate wrapper, a
 * `claude` installed somewhere odd, a GUI-app PATH missing the version-manager
 * node. This lets the user pin an absolute binary path per tool from the app.
 *
 *   { "bins": { "claude": "/opt/claude/bin/claude", "node": "/usr/local/bin/node" },
 *     "extraPath": ["/some/extra/bin"],
 *     "env": { "ANTHROPIC_API_KEY": "…" } }
 *
 * `bins[name]` → spawn that exact path (and its dir goes on PATH so `env node`
 * shebangs inside a wrapper resolve). `extraPath` → extra PATH search dirs.
 * `env` → extra environment variables. All fields optional.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CONFIG_DIR = path.join(os.homedir(), ".pounce");
export const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

let cache = null;
let cacheKey = "";

function normalize(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const bins = {};
  if (r.bins && typeof r.bins === "object") {
    for (const [k, v] of Object.entries(r.bins)) {
      if (typeof v === "string" && v.trim()) bins[k] = v.trim();
    }
  }
  const env = {};
  if (r.env && typeof r.env === "object") {
    for (const [k, v] of Object.entries(r.env)) {
      if (typeof v === "string") env[k] = v;
    }
  }
  const extraPath = Array.isArray(r.extraPath)
    ? r.extraPath.filter((p) => typeof p === "string" && p.trim()).map((p) => p.trim())
    : [];
  // Opt-in Admin API key for official org spend (agents/admin-cost.mjs). Kept
  // here rather than in an env var so it survives restarts and can be set from
  // the app; the HTTP layer never reads it back out (see publicConfig).
  const adminApiKey =
    typeof r.adminApiKey === "string" && r.adminApiKey.trim() ? r.adminApiKey.trim() : "";
  return { bins, extraPath, env, adminApiKey };
}

/** Current config (cached until the file's mtime changes). Never throws. */
export function readConfig() {
  try {
    const st = fs.statSync(CONFIG_FILE);
    const key = `${st.mtimeMs}:${st.size}`;
    if (cache && key === cacheKey) return cache;
    cache = normalize(JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")));
    cacheKey = key;
    return cache;
  } catch {
    cache = normalize({});
    cacheKey = "";
    return cache;
  }
}

/**
 * Merge a patch and persist. `bins`/`env` merge key-by-key; passing an empty
 * string for a key CLEARS that override. `extraPath`, when provided, replaces.
 */
export function writeConfig(patch = {}) {
  const cur = readConfig();
  const bins = { ...cur.bins };
  if (patch.bins && typeof patch.bins === "object") {
    for (const [k, v] of Object.entries(patch.bins)) {
      if (typeof v === "string" && v.trim()) bins[k] = v.trim();
      else delete bins[k]; // "" / null clears the override
    }
  }
  const env = { ...cur.env };
  if (patch.env && typeof patch.env === "object") {
    for (const [k, v] of Object.entries(patch.env)) {
      if (typeof v === "string" && v) env[k] = v;
      else delete env[k];
    }
  }
  const extraPath = patch.extraPath !== undefined ? patch.extraPath : cur.extraPath;
  // "" clears the stored key, mirroring how bins/env overrides are cleared.
  const adminApiKey = patch.adminApiKey !== undefined ? patch.adminApiKey : cur.adminApiKey;
  const next = normalize({ bins, env, extraPath, adminApiKey });
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2) + "\n");
  cache = next;
  try {
    const st = fs.statSync(CONFIG_FILE);
    cacheKey = `${st.mtimeMs}:${st.size}`;
  } catch {}
  return next;
}

/**
 * Config as it may leave this machine.
 *
 * Lives here, next to the field it redacts, rather than in the HTTP layer: the
 * Admin API key is a bearer credential for the org's BILLING account, so it is
 * write-only — settable over /v1/config, never readable back. A paired phone
 * gets a boolean and nothing else, the same reasoning that keeps /v1/file
 * image-only. Any future response that embeds config must go through this, and
 * any future secret added to `normalize()` must be dropped here in the same
 * edit.
 */
export function publicConfig(config = readConfig()) {
  const { adminApiKey, ...rest } = config || {};
  return { ...rest, adminApiKeySet: typeof adminApiKey === "string" && adminApiKey.length > 0 };
}

/** The configured absolute path for a binary, or null if none. */
export function binOverride(name) {
  return readConfig().bins[name] || null;
}
