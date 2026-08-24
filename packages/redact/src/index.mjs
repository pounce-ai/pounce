/**
 * @pounce/redact — strip credentials from a payload before it leaves the machine.
 *
 * Four layers, in decreasing precision:
 *
 *   1. machine denylist — the credentials actually live on THIS box, read from
 *      the agent credential stores, the project `.env`, and secret-named
 *      environment variables. Exact match, zero false positives. Only an
 *      at-source scrubber can have this layer at all.
 *   2. known formats    — `sk-ant-…`, `ghp_…`, PEM blocks, JWTs, connection
 *      strings, `Authorization: Bearer …`. Published shapes, so no entropy gate.
 *   3. named assignments— anything whose key says secret/token/password. Keyed
 *      on the NAME, because `password = hunter2` has no entropy and is still a
 *      password.
 *   4. entropy runs     — bare random-looking strings. OFF by default: in a
 *      coding transcript this fires on every git SHA.
 *
 * Redaction is a CONTROL, NOT A GUARANTEE. A low-entropy secret with no name
 * and no known format survives all four layers, as does one the model
 * paraphrased into prose or buried in a base64 blob. The stronger posture is
 * to not collect content at all — which is why the metrics this repo actually
 * ships (plan-window burn, token counts, folded blocks) carry no free text and
 * need none of this. Use redaction for the paths where content genuinely has
 * to travel, and say plainly that it is best-effort.
 *
 * Everything here is synchronous, dependency-free, and throws rather than
 * degrading: a redactor that silently returns its input is worse than none,
 * because the caller cannot tell. Drop the payload on a throw.
 */
export { createRedactor, placeholderFor } from "./redact.mjs";
export { harvestMachineSecrets } from "./denylist.mjs";
export { shannon } from "./entropy.mjs";
export { PATTERNS } from "./patterns.mjs";
