/**
 * One-time pairing codes — what the QR hands out instead of the bridge token.
 *
 * THE PROBLEM THIS EXISTS FOR. The pairing deep link used to carry TOKEN
 * itself, and TOKEN is replayed on the `Authorization` header of every request
 * a paired device ever makes. Over the LAN that header is plaintext HTTP, so
 * one sniffed request on a hostile network yields the master credential — and
 * from there `/v1/pair` yields the tunnel identity, which is permanent remote
 * access to a machine that serves `/v1/exec`. The damage was never bounded by
 * the attacker staying on the network.
 *
 * A pairing code breaks that chain in two places. It is worth exactly one call
 * to `/v1/device/adopt`, so sniffing it after the phone has paired buys
 * nothing; and it is never a credential for anything else, so it cannot read
 * history, run a turn, or ask for the tunnel. What comes back from adopt is a
 * per-device token (devices.mjs) that is not the master token and cannot be
 * traded for it.
 *
 * DELIBERATELY IN MEMORY. A code is only ever shown by a running bridge, on a
 * QR its own process is rendering. Persisting it would keep a live credential
 * on disk across restarts for no reason anyone benefits from — the next boot
 * mints another in microseconds.
 *
 * The TTL is a backstop, not the security boundary; single-use is. A QR left on
 * a screen all afternoon is the case it covers.
 */
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

const sha256 = (s) => createHash("sha256").update(s).digest();

/** Constant-time compare, length-guarded because timingSafeEqual throws on a
 *  length mismatch rather than returning false. */
function digestMatches(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * @param {{ ttlMs?: number, now?: () => number }} [opts] test seams
 */
export function createPairCodes({ ttlMs = 10 * 60_000, now = () => Date.now() } = {}) {
  /** @type {{ code: string, digest: Buffer, expiresAt: number } | null} */
  let live = null;

  const expired = () => !live || now() >= live.expiresAt;

  return {
    /**
     * The code to put on the QR right now, minting one if the last has expired
     * or been claimed.
     *
     * Stable between calls on purpose: `/ui` polls and re-renders `/qr.svg` on
     * a timer, and a code that changed per render would race the camera — the
     * phone would decode a value the bridge had already replaced. It rotates on
     * the clock, or the moment it is spent, and not otherwise.
     */
    current() {
      if (expired()) {
        const code = randomBytes(16).toString("hex");
        live = { code, digest: sha256(code), expiresAt: now() + ttlMs };
      }
      return { code: live.code, expiresAt: live.expiresAt };
    },

    /** Is this a live code? Does NOT spend it — the auth gate needs to know a
     *  code is real before it routes the request that will spend it. */
    peek(presented) {
      if (typeof presented !== "string" || !presented || expired()) return false;
      return digestMatches(sha256(presented), live.digest);
    },

    /**
     * Spend a code. True exactly once per minted code; every later call — a
     * replay, a second phone racing the same QR — is false.
     */
    claim(presented) {
      if (!this.peek(presented)) return false;
      live = null;
      return true;
    },

    /** Drop the live code without spending it (pairing window closed). */
    invalidate() {
      live = null;
    },
  };
}
