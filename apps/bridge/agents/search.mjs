/**
 * HistorySearch — full-text search over on-disk agent session history.
 *
 * Backed by the ctx CLI (https://github.com/ctxrs/ctx): a local, read-only
 * SQLite index over the same transcript files the adapters read. This module
 * is the ONLY place that knows the backend is ctx — server.mjs sees just
 * { available, search, refresh }, so the indexer stays swappable (cass, or a
 * homegrown FTS5 index, would slot in behind the same three calls).
 *
 * ctx provider ids happen to equal our adapter ids ("claude", "codex",
 * "opencode"), and its provider_session_id is the same id each adapter uses
 * as threadId (the transcript filename stem / ses_* id) — verified on all
 * three. Results for providers we can't drive are filtered out unless the
 * caller opts in.
 *
 * ctx never runs as a daemon here: searches use --refresh off, and freshness
 * comes from refresh() — a debounced, single-flight `ctx daemon run --once`
 * the server fires after turns complete.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Tool-output snippets keep the CLI's ANSI color codes — strip for UI text.
const ANSI_RE = /\u001b\[[0-9;]*m/g;

const SEARCH_TIMEOUT_MS = 15_000;
const REFRESH_TIMEOUT_MS = 180_000;
const REFRESH_DEBOUNCE_MS = 5_000;
const INSTALL_TIMEOUT_MS = 120_000;

// Pinned ctx release, auto-installed into ~/.pounce/bin when no ctx is found
// (same drop location as pounce-tunnel). Version bumps are deliberate: update
// the tag AND every hash from the release's SHA256SUMS together.
const CTX_VERSION = "v0.25.0";
const CTX_ASSETS = {
  "darwin-arm64": {
    name: "ctx-macos-arm64",
    sha256: "e02701896c2189fe5c622ecd5326c3bf57a5cda8febef942418e79203e543d20",
  },
  "darwin-x64": {
    name: "ctx-macos-x64",
    sha256: "8283ef3ffc1aad0099f18593cc10f3f1a1d0e1a61dce031d3a737ebdf83f5dd8",
  },
  "linux-x64": {
    name: "ctx-linux-x64",
    sha256: "44fdc710c142c686c3b6ecb88bfad584f94abff3281ccfa389a4d2320c7ce526",
  },
  "linux-arm64": {
    name: "ctx-linux-aarch64",
    sha256: "4aa5d9ec83e82be567ed290e25ad2fa91f1aa4cfe15329767046fa114693d98a",
  },
  "win32-x64": {
    name: "ctx-windows-x64.exe",
    sha256: "32aa550cc5c56d4d2989d0f929bbc1e634d8b730219feb8e4a4ba770b02a9867",
  },
};

const EXE = process.platform === "win32" ? "ctx.exe" : "ctx";
const POUNCE_BIN = path.join(os.homedir(), ".pounce", "bin");

/** Locate the ctx binary: env override, then PATH, then the ctx installer's
 *  drop location (~/.local/bin), then our own bootstrap location
 *  (~/.pounce/bin — a user-managed install always wins over ours). */
function findCtx() {
  if (process.env.CTX_BIN) return existsSync(process.env.CTX_BIN) ? process.env.CTX_BIN : null;
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (dir && existsSync(path.join(dir, EXE))) return path.join(dir, EXE);
  }
  for (const dir of [path.join(os.homedir(), ".local", "bin"), POUNCE_BIN]) {
    if (existsSync(path.join(dir, EXE))) return path.join(dir, EXE);
  }
  return null;
}

/** Download the pinned ctx release for this platform into ~/.pounce/bin.
 *  Refuses to keep anything whose sha256 doesn't match the pin. Returns the
 *  installed path, or null (unsupported platform / network failure). */
async function downloadCtx(log) {
  const asset = CTX_ASSETS[`${process.platform}-${process.arch}`];
  if (!asset) return null;
  const url = `https://github.com/ctxrs/ctx/releases/download/${CTX_VERSION}/${asset.name}`;
  log(`downloading ctx ${CTX_VERSION} (${asset.name})…`);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), INSTALL_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const digest = createHash("sha256").update(buf).digest("hex");
    if (digest !== asset.sha256) throw new Error(`checksum mismatch for ${asset.name}`);
    mkdirSync(POUNCE_BIN, { recursive: true });
    const dest = path.join(POUNCE_BIN, EXE);
    const tmp = `${dest}.download`;
    writeFileSync(tmp, buf);
    chmodSync(tmp, 0o755);
    renameSync(tmp, dest);
    log(`ctx installed at ${dest}`);
    return dest;
  } catch (e) {
    try {
      unlinkSync(path.join(POUNCE_BIN, `${EXE}.download`));
    } catch {}
    log(`ctx install failed: ${e?.message || e}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Run ctx with args, resolve parsed JSON stdout. Rejects on nonzero exit,
 *  bad JSON, or timeout. */
function ctxJson(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "",
      err = "",
      killed = false;
    const timer = setTimeout(() => {
      killed = true;
      p.kill("SIGKILL");
    }, timeoutMs);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => {
      clearTimeout(timer);
      if (killed) return reject(new Error("ctx timed out"));
      if (code !== 0) return reject(new Error(err.trim() || `ctx exited ${code}`));
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new Error("ctx returned non-JSON output"));
      }
    });
    p.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

export function createHistorySearch() {
  let bin; // resolved lazily so an install after bridge start is picked up
  const resolveBin = () => (bin ??= findCtx()) || (bin = findCtx());
  const log = (m) => console.log(`[search] ${m}`);

  let installing = null;
  let refreshing = null;
  let refreshQueued = false;
  let refreshTimer = null;

  /** One bounded foreground import pass. Single-flight with trailing rerun:
   *  a turn finishing mid-refresh queues exactly one follow-up so its
   *  transcript is never left unindexed. */
  async function refreshNow() {
    const b = resolveBin();
    if (!b) return;
    if (refreshing) {
      refreshQueued = true;
      return;
    }
    refreshing = (async () => {
      try {
        const status = await ctxJson(b, ["status", "--json"], SEARCH_TIMEOUT_MS).catch(() => null);
        // First run on a machine where ctx was installed but never set up
        // (a fresh bootstrap has no store at all, so status may also error).
        if (!status || status.initialized === false) {
          await ctxJson(b, ["setup", "--quiet", "--no-daemon", "--json"], REFRESH_TIMEOUT_MS);
          return;
        }
        await ctxJson(b, ["daemon", "run", "--once", "--force", "--json"], REFRESH_TIMEOUT_MS);
      } catch (e) {
        if (process.env.BRIDGE_DEBUG) console.log(`[search] refresh failed: ${e?.message || e}`);
      } finally {
        refreshing = null;
        if (refreshQueued) {
          refreshQueued = false;
          refreshNow();
        }
      }
    })();
    await refreshing;
  }

  return {
    available() {
      return !!resolveBin();
    },

    /** Bootstrap ctx when it isn't installed: download the pinned release,
     *  then index existing history. Single-flight; safe to call repeatedly.
     *  No-op when ctx already exists or the platform has no pinned asset. */
    ensureInstalled() {
      if (resolveBin()) return Promise.resolve(true);
      installing ??= downloadCtx(log).then((dest) => {
        installing = null;
        if (!dest) return false;
        bin = dest;
        this.refresh(); // first refresh runs `ctx setup` and builds the index
        return true;
      });
      return installing;
    },

    /** Debounced background index refresh; fire-and-forget. */
    refresh() {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => void refreshNow(), REFRESH_DEBOUNCE_MS);
      refreshTimer.unref?.();
    },

    /**
     * Search indexed history. Returns [{ agent, threadId, snippet, title,
     * timestamp, matches }] — threadId is the adapter thread id, so hits
     * join directly against /v1/threads. `providers` limits results to agents
     * the caller can display (pass null for everything ctx indexed).
     *
     * `thread` scopes to ONE session and switches to event-level results
     * (multiple hits within the thread, one per matching message) — the
     * in-thread search. ctx's search only filters by its own session ids, so
     * the adapter thread id is first resolved via the read-only SQL view.
     */
    async search({ q, agent, workspace, since, thread, limit = 20, providers = null }) {
      const b = resolveBin();
      if (!b) throw new Error("ctx not installed");
      const args = [
        "search",
        q,
        "--json",
        "--refresh",
        "off",
        "--limit",
        String(Math.min(limit, 50)),
      ];
      if (agent) args.push("--provider", agent);
      if (workspace) args.push("--workspace", workspace);
      if (since) args.push("--since", since);
      if (thread) {
        const sql = `SELECT ctx_session_id FROM ctx_sessions WHERE provider_session_id = '${String(thread).replace(/'/g, "''")}' ORDER BY is_primary DESC LIMIT 1`;
        const lookup = await ctxJson(b, ["sql", sql, "--json"], SEARCH_TIMEOUT_MS).catch(
          () => null,
        );
        const ctxSessionId = lookup?.rows?.[0]?.[0];
        if (!ctxSessionId) return [];
        args.push("--session", ctxSessionId, "--events");
      }
      const data = await ctxJson(b, args, SEARCH_TIMEOUT_MS);
      const results = [];
      for (const r of data.results || []) {
        if (!r.provider_session_id) continue; // session unidentifiable — can't deep-link
        if (providers && !providers.includes(r.provider)) continue;
        results.push({
          agent: r.provider,
          threadId: r.provider_session_id,
          snippet: (r.snippet || "").replace(ANSI_RE, ""),
          title: r.title || null,
          timestamp: r.timestamp || null,
          matches: (r.more_matches_in_session || 0) + 1,
        });
      }
      return results;
    },
  };
}
