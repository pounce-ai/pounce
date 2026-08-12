/**
 * One credential per paired device, instead of one credential for all of them.
 *
 * THE PROBLEM THIS EXISTS FOR. The bridge had a single token (token.mjs) that
 * was both its identity and every device's password. That made rotation
 * all-or-nothing and, worse, ONE-WAY: `/v1/token` is the only way back and it
 * needs the very credential that just stopped working. So anything that changed
 * the token behind a paired phone's back — an upgrade whose 24h window elapsed
 * while the phone was off, a reinstall, a deleted or torn ~/.pounce — dropped
 * that phone for good, with a device list that just said nothing was online.
 * The desktop app could recover (adoptBridgeToken, reading its own loopback
 * /ui) precisely because it is the same machine; a phone never can.
 *
 * The same single token made un-pairing absurd from the other direction, as
 * access.mjs already records: removing one phone meant rotating the shared
 * token, which ended every OTHER device too.
 *
 * So: a device adopts its own token on first sync and uses that from then on.
 * Nothing about an update rotates it, so an update cannot drop it. Revoking one
 * device deletes one row and no other device notices.
 *
 * Stored as HASHES, like access.mjs stores grant tokens — the plaintext is
 * handed back exactly once, at mint. A readable state file is then not a
 * credential, which is what lets this share Store's ordinary file mode.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Store } from "./store.mjs";

const sha256 = (s) => createHash("sha256").update(s).digest();

/** Constant-time compare of two digests. Length-guarded because
 *  timingSafeEqual throws on a mismatch rather than returning false. */
function digestMatches(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function str(v, max) {
  return typeof v === "string" && v ? v.slice(0, max) : null;
}

/**
 * @param {{ store?: Store, now?: () => number }} [opts] test seams
 */
export function createDevices({ store = new Store("devices"), now = () => Date.now() } = {}) {
  const rows = () => Object.values(store.withPrefix("dev:"));

  const publicRow = (d) => ({
    id: d.id,
    name: d.name,
    platform: d.platform,
    pairedAt: new Date(d.pairedAt).toISOString(),
    lastSeenAt: d.lastSeenAt ? new Date(d.lastSeenAt).toISOString() : null,
  });

  const api = {
    /**
     * Issue a credential for one device. Returns the plaintext ONCE — only the
     * hash is kept, so a lost token is re-minted rather than recovered.
     *
     * `key` is the caller's stable id for the device (the app's own device id,
     * or a peer's bridgeId). Re-minting under the same key REPLACES that row:
     * a phone that reinstalled should end up with one credential, not a second
     * one nobody can attribute. Passing none mints a fresh row.
     */
    mint({ key, name, platform } = {}) {
      const id = str(key, 128) || randomBytes(16).toString("hex");
      const token = randomBytes(32).toString("hex");
      store.set(`dev:${id}`, {
        id,
        name: str(name, 64) || "device",
        platform: str(platform, 16) || "unknown",
        tokenHash: sha256(token).toString("hex"),
        pairedAt: store.get(`dev:${id}`)?.pairedAt ?? now(),
        lastSeenAt: null,
      });
      return { id, token };
    },

    /** Resolve a presented bearer token to its device row, or null. */
    forToken(token) {
      if (typeof token !== "string" || !token) return null;
      const digest = sha256(token);
      for (const d of rows()) {
        if (digestMatches(digest, Buffer.from(d.tokenHash, "hex"))) return d;
      }
      return null;
    },

    /** "Last active" in the owner's device list. */
    touch(id) {
      const d = store.get(`dev:${id}`);
      if (d) store.set(`dev:${id}`, { ...d, lastSeenAt: now() });
    },

    /**
     * Drop one device's credential. Unlike rotating the shared token, this ends
     * exactly one device — which is the entire point of the file.
     */
    revoke(id) {
      return store.delete(`dev:${id}`);
    },

    list() {
      return rows()
        .sort((a, b) => (b.lastSeenAt ?? b.pairedAt) - (a.lastSeenAt ?? a.pairedAt))
        .map(publicRow);
    },

    /** Does this install have any per-device credential yet? Tells an upgrade
     *  ("devices exist, they still hold the shared token") from a fleet that has
     *  finished adopting and no longer needs the shared one honoured. */
    count() {
      return rows().length;
    },
  };

  return api;
}
