/**
 * The bridge's own credential.
 *
 * This used to be the constant `pounce-bridge-local` whenever BRIDGE_TOKEN was
 * unset — which is every desktop-app install, since nothing under desktop/ sets
 * it. That is a published password on a service that exposes /v1/exec: anyone on
 * the same Wi-Fi could scan for port 8099 and run commands, no sniffing needed.
 * (`npx use-pounce` was never affected — the CLI already mints a random token.)
 *
 * So: a 256-bit random token, minted once and persisted 0600 under ~/.pounce.
 *
 * MIGRATION. Phones store the token they were paired with, so a new one 401s
 * every existing pairing. Rather than force a re-pair, an UPGRADED install keeps
 * accepting the legacy constant for a short window, during which:
 *   - it is good for read-only routes ONLY (see legacyAllows) — never /v1/exec,
 *     never a turn, never /v1/pair or /v1/config, which would hand over
 *     credentials — so the dangerous surface is protected from the first minute;
 *   - the app silently swaps in the real token on its next sync via /v1/token.
 * The window is deliberately tiny: an app that syncs once closes it immediately,
 * and it is a wall-clock backstop for one that doesn't, not a grace period to
 * rely on. A FRESH install never opens it at all — nobody holds a token there,
 * so there is nothing to migrate and no reason to accept the public one.
 *
 * The residual risk, stated plainly: while the window is open, an attacker who
 * knows the legacy constant can also read history and call /v1/token. That is
 * the cost of not making every user re-pair, and it is bounded by the clock.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const POUNCE_DIR = path.join(os.homedir(), ".pounce");
const TOKEN_FILE = path.join(POUNCE_DIR, "token.json");
/** The published constant every build shipped before this change. */
export const LEGACY_TOKEN = "pounce-bridge-local";
/** How long an upgraded install keeps honouring it. Hours, overridable for a
 *  fleet that can't sync quickly; 0 disables the window outright. */
const LEGACY_HOURS = Number(process.env.BRIDGE_LEGACY_TOKEN_HOURS ?? 24);

/** Does ~/.pounce already hold state from a previous run? Distinguishes an
 *  upgrade (paired devices exist, migrate them) from a first install (nothing to
 *  migrate — the legacy token must never be accepted). */
function looksLikeUpgrade(dir) {
  for (const name of ["state", "index", "bridge.db", "tunnel.json", "usage.jsonl"]) {
    if (existsSync(path.join(dir, name))) return true;
  }
  return false;
}

function writeToken(file, payload) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600); // rename preserves the tmp mode, but be explicit
  } catch {}
}

let cached = null;

/**
 * `{ token, legacyUntil }` for this install — minted and persisted on first use.
 * BRIDGE_TOKEN still wins outright (the CLI passes one per run), and setting it
 * never opens the legacy window.
 */
export function bridgeToken({ dir = POUNCE_DIR, file = TOKEN_FILE } = {}) {
  if (cached) return cached;
  if (process.env.BRIDGE_TOKEN) {
    cached = { token: process.env.BRIDGE_TOKEN, legacyUntil: 0 };
    return cached;
  }
  let present = false;
  try {
    present = existsSync(file);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    if (typeof saved?.token === "string" && saved.token) {
      cached = { token: saved.token, legacyUntil: Number(saved.legacyUntil) || 0 };
      return cached;
    }
  } catch {
    // Fall through to the guard below: absent means mint, unreadable does not.
  }
  // A token file that EXISTS but won't parse is not the same as no token file.
  // Minting over it — which is what used to happen — silently invalidates the
  // credential every paired device is holding, and `/v1/token` cannot hand back
  // a replacement to a device whose token is already wrong. That is the one-way
  // door described in devices.mjs, walked through by a single bad read.
  //
  // So: keep the damaged file, and serve a token that works for this run only.
  // Devices that have adopted their own credential (the common case after one
  // sync) are unaffected either way — that is the durable half of the fix, and
  // this is the half that stops a torn file taking the shared token with it.
  if (present) {
    console.warn(
      `[pounce] ${file} exists but could not be read — leaving it untouched. ` +
        `Paired devices holding their own credential are unaffected; anything ` +
        `still on the shared token may need to re-pair. Move the file aside to mint a new one.`,
    );
    cached = { token: randomBytes(32).toString("hex"), legacyUntil: 0 };
    return cached;
  }
  const legacyUntil =
    LEGACY_HOURS > 0 && looksLikeUpgrade(dir) ? Date.now() + LEGACY_HOURS * 3600_000 : 0;
  const next = { token: randomBytes(32).toString("hex"), legacyUntil };
  try {
    writeToken(file, next);
  } catch {
    // An unwritable ~/.pounce would otherwise mint a new token every restart and
    // break every pairing on each one. Fall back to the legacy constant, which
    // at least keeps paired devices working, and say so loudly.
    console.warn(
      `[pounce] could not persist ${file} — falling back to the shared default token. ` +
        `Set BRIDGE_TOKEN to a secret of your own.`,
    );
    cached = { token: LEGACY_TOKEN, legacyUntil: 0 };
    return cached;
  }
  cached = next;
  return cached;
}

/** Constant-time compare, so a wrong token can't be found a byte at a time. */
export function tokenMatches(presented, expected) {
  if (typeof presented !== "string" || typeof expected !== "string") return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Routes the legacy token may still reach while the migration window is open:
 * reads only, and never one that discloses a credential. /v1/pair hands out the
 * token for the tunnel and /v1/config carries provider keys, so both are denied
 * even though they are GETs. /v1/token is the one deliberate exception — it IS
 * the migration.
 */
const LEGACY_DENY = new Set([
  "/v1/pair",
  "/v1/config",
  "/v1/exec",
  // Minting a per-device credential from a password that is in the git history
  // would turn a window bounded by the clock into one that never closes. The
  // GET/HEAD test below already refuses this POST; naming it here means a later
  // decision to let the legacy token write something cannot open it by accident.
  "/v1/device/adopt",
]);
export function legacyAllows(method, pathname) {
  if (pathname === "/v1/token") return true;
  if (method !== "GET" && method !== "HEAD") return false;
  return !LEGACY_DENY.has(pathname);
}

/** Test seam — drops the memoised value so the file is consulted again. */
export function _reset() {
  cached = null;
}
