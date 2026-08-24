/**
 * The bridge's seam onto @pounce/redact.
 *
 * The package is deliberately ignorant of this machine — it takes a denylist,
 * it does not go looking for one. This module is what knows where the secrets
 * are: the harvester's own list of agent credential stores, plus the two
 * credentials the bridge itself holds and the package could never guess — its
 * HTTP token and the opt-in Admin API key from config.
 *
 * HARVESTING IS MEMOIZED because it is real file I/O (four credential stores,
 * plus every `.env` in a project) and an export is not a rare call. Credentials
 * rotate on the order of weeks; a minute of staleness costs nothing, and the
 * memo is keyed by project so two repos don't share each other's `.env` values.
 *
 * Import redaction FROM HERE inside the bridge, the same way metering goes
 * through `agents/meter.mjs` — going straight to the package gets you a
 * redactor with an empty denylist, which is the layer that matters most.
 */
import { createRedactor, harvestMachineSecrets } from "@pounce/redact";
import os from "node:os";
import { readConfig } from "./config.mjs";
import { bridgeToken } from "./token.mjs";

const TTL_MS = 60_000;

/** @type {Map<string, { at: number, redactor: ReturnType<typeof createRedactor> }>} */
const memo = new Map();

/**
 * A redactor primed with this machine's live credentials.
 *
 * @param {{ cwd?: string|null }} [opts]
 */
export function getRedactor({ cwd = null } = {}) {
  const key = cwd || "";
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.redactor;

  // The bridge's own credentials. A transcript that debugged a pairing problem
  // very plausibly contains the bridge token — it is printed on startup and
  // pasted into curl — and nothing about its shape would make a pattern rule
  // notice it.
  const extra = [];
  try {
    extra.push(bridgeToken());
  } catch {
    // No token file yet (first run): nothing to protect.
  }
  try {
    const { adminApiKey } = readConfig() || {};
    if (adminApiKey) extra.push(adminApiKey);
  } catch {
    // An unreadable config contributes nothing rather than failing the export.
  }

  const redactor = createRedactor({
    denylist: harvestMachineSecrets({ cwd, extra }),
    home: os.homedir(),
  });
  memo.set(key, { at: Date.now(), redactor });
  return redactor;
}

/** Drop the memo — after a token rotation, or in tests. */
export function resetRedactor() {
  memo.clear();
}

/**
 * Redact a document that is about to leave this machine.
 *
 * THROWS on failure, and the caller must not fall back to sending the input:
 * that is the difference between a control and a decoration.
 *
 * @returns {{ value: any, findings: Record<string, number>, count: number }}
 */
export function redactDocument(doc, { cwd = null } = {}) {
  return getRedactor({ cwd }).redact(doc);
}
