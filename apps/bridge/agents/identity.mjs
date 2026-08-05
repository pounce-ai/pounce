/**
 * A stable id for the machine this bridge runs on.
 *
 * The apps used to identify a paired machine by the URL it was reached at, so
 * one Mac showed up as several devices: `192.168.1.3` on the LAN, `127.0.0.1`
 * from a simulator, `10.0.2.2` from the Android emulator, and again at any new
 * address a DHCP lease handed out. A machine can't be recognised from the
 * outside — the address is a property of the network path, not of the host — so
 * the bridge names itself and the apps key off that.
 *
 * DERIVED from the OS's own machine identifier (node-machine-id: IOPlatformUUID
 * on macOS, /etc/machine-id on Linux, MachineGuid on Windows) rather than minted
 * at random, because the identity has to hold in two cases a stored random value
 * gets wrong:
 *
 *   - Losing the state file. `Store.flush` deliberately swallows write errors,
 *     so an unwritable ~/.pounce would mint a fresh random id on every restart
 *     and add a device row each time — the very bug this exists to fix. A
 *     derived id is the same value on every boot without persisting anything.
 *   - Copying ~/.pounce to a second machine (Time Machine restore, disk clone,
 *     dotfile sync). Two genuinely different machines would then share an id and
 *     the apps would merge them into one device, silently mixing their threads.
 *     Distinct hardware reports distinct identifiers.
 *
 * The library already hashes, but that hash is a plain digest of the OS value —
 * identical for every app using this package. Hashing again with an app-specific
 * prefix scopes the id to Pounce, so what leaves the machine can't be correlated
 * with anything else reading the same OS value. Hostnames are deliberately not
 * used: two machines can share one and any user can change it.
 *
 * Hosts where no identifier is readable (containers, locked-down images) fall
 * back to a random uuid persisted in ~/.pounce/state — the original behaviour,
 * stable as long as that file survives.
 */
import { createHash, randomUUID } from "node:crypto";
// Default-imported, not destructured at the import: node-machine-id is CJS whose
// bundled output Node's ESM lexer can't read named exports from, so
// `import { machineIdSync }` throws at load under plain `node server.mjs` — even
// though bun and vitest resolve it fine.
import nodeMachineId from "node-machine-id";
import { Store } from "./store.mjs";

const { machineIdSync } = nodeMachineId;

let cached = null;

/** The OS's machine identifier, or null where none is readable. Best-effort by
 *  design: an identity lookup must never take the bridge down. */
export function machineFingerprint() {
  try {
    return machineIdSync() || null;
  } catch {
    return null;
  }
}

/** A random id, minted once and persisted, for hosts with no machine id. */
function storedRandomId() {
  const store = new Store("identity");
  let id = store.get("bridgeId");
  if (typeof id !== "string" || !id) {
    id = randomUUID();
    store.set("bridgeId", id);
  }
  return id;
}

/** This machine's stable id, as reported to paired apps on /v1/status. */
export function bridgeId() {
  if (cached) return cached;
  const fingerprint = machineFingerprint();
  cached = fingerprint
    ? createHash("sha256").update(`pounce-bridge:${fingerprint}`).digest("hex").slice(0, 32)
    : storedRandomId();
  return cached;
}

/** Test seam — drops the memoised value so the source is consulted again. */
export function _reset() {
  cached = null;
}

/** Exposed for diagnostics: how this machine's id was arrived at. */
export function identitySource() {
  return machineFingerprint() ? "os-machine-id" : "random-persisted";
}
