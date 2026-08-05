/**
 * A stable id for this bridge installation.
 *
 * The apps used to identify a paired machine by the URL it was reached at, so
 * one Mac showed up as several devices: `192.168.1.3:8099` on the LAN,
 * `127.0.0.1` from a simulator, `10.0.2.2` from the Android emulator, and again
 * at any new address a DHCP lease handed out. Each address minted its own
 * device, so filter lists showed the same machine repeatedly and threads synced
 * under one address were orphaned when the next one appeared.
 *
 * A machine can't be recognised from the outside — the address is a property of
 * the network path, not of the host — so the bridge names itself and the apps
 * key off that. Persisted (never derived from hostname, which two machines can
 * share and any user can change) so it survives restarts, port changes and
 * re-pairing.
 */
import { randomUUID } from "node:crypto";
import { Store } from "./store.mjs";

let cached = null;

/** This installation's stable id, minted on first use. */
export function bridgeId() {
  if (cached) return cached;
  const store = new Store("identity");
  let id = store.get("bridgeId");
  if (typeof id !== "string" || !id) {
    id = randomUUID();
    store.set("bridgeId", id);
  }
  cached = id;
  return id;
}

/** Test seam — drops the memoised value so a fresh Store is consulted. */
export function _reset() {
  cached = null;
}
