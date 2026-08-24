/**
 * The redactor — composes the layers and walks a whole document.
 *
 * LAYER ORDER is not cosmetic. The machine denylist runs first because it is
 * the only layer that knows a value is a secret rather than inferring it, so
 * it should get to label the finding. Multi-line private keys run next, before
 * any single-line rule can punch a hole in the middle of a PEM block and leave
 * the delimiters stranded. Named assignments run last, so `ANTHROPIC_API_KEY=
 * sk-ant-…` is reported as the Anthropic key it is rather than the generic
 * "some named secret".
 *
 * IDEMPOTENCE. Redacting twice must not double-wrap, or a payload that passes
 * through two collectors turns into nested noise. Placeholders are
 * `[redacted:kind]` — no pattern here matches that shape, and the assignment
 * layer explicitly skips a value that already is one.
 *
 * FINDINGS CARRY NO VALUES. A finding is a rule name and a count. That is
 * enough to tell a reviewer the ruleset fired and not enough to reconstruct
 * anything — which matters because findings are the part designed to be shown
 * in a UI and logged.
 *
 * THIS THROWS RATHER THAN DEGRADES. A redactor that returns the input when it
 * fails is worse than no redactor, because the caller cannot tell the
 * difference. Every failure path here throws, and callers are expected to drop
 * the payload on a throw — see the trajectory route in the bridge.
 */
import { PARTIAL, PATTERNS } from "./patterns.mjs";
import { redactAssignments, redactEntropyRuns } from "./entropy.mjs";

/** Cap on document size: past this we refuse rather than block the event loop. */
const MAX_BYTES = 32 * 1024 * 1024;

/** Cap on recursion into a document's structure. */
const MAX_DEPTH = 64;

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const placeholderFor = (name) => `[redacted:${name}]`;

/**
 * Rewrite an absolute home path to `~`, dropping the account name.
 *
 * A username is not a credential, but it is the one identifier that appears in
 * essentially every path in a transcript, and stripping it makes an exported
 * trajectory shareable without a second thought.
 */
function normalizeHomePaths(text, home) {
  if (!home) return text;
  const parent = home.slice(0, home.lastIndexOf("/") + 1) || "/Users/";
  // The specific home first, then any sibling account under the same parent.
  const out = text.split(home).join("~");
  return out.replace(new RegExp(`${escapeRegExp(parent)}[^/\\s"']+`, "g"), "~");
}

/**
 * Build a redactor.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.denylist] Exact secret values from this machine.
 * @param {boolean} [opts.patterns] Known-format rules (default true).
 * @param {boolean} [opts.assignments] Named-secret assignments (default true).
 * @param {boolean} [opts.entropy] Bare high-entropy runs (default FALSE — it
 *   spares hex but fires on base64 content; see entropy.mjs).
 * @param {string|null} [opts.home] Home directory to fold to `~`, or null to
 *   leave paths alone.
 */
export function createRedactor(opts = {}) {
  const { denylist = [], patterns = true, assignments = true, entropy = false, home = null } = opts;

  // Pre-compile the denylist once; it can hold hundreds of values and the
  // redactor is applied to every string in a document.
  const denyRules = denylist
    .filter((v) => typeof v === "string" && v.length >= 8)
    .map((v) => new RegExp(escapeRegExp(v), "g"));

  /**
   * Redact one string.
   * @returns {{ text: string, findings: Record<string, number> }}
   */
  function redactText(input) {
    if (typeof input !== "string") throw new TypeError("redactText expects a string");
    const findings = Object.create(null);
    const note = (name) => {
      findings[name] = (findings[name] || 0) + 1;
    };

    let text = input;

    // 1. Known-live values from this machine.
    for (const re of denyRules) {
      text = text.replace(re, () => {
        note("machine-secret");
        return placeholderFor("machine-secret");
      });
    }

    // 2. Published credential formats.
    if (patterns) {
      for (const { name, re } of PATTERNS) {
        text = text.replace(re, (match, ...rest) => {
          note(name);
          const partial = PARTIAL[name];
          if (!partial) return placeholderFor(name);
          // Trailing args of String.replace are offset and full string.
          const groups = rest.slice(0, -2);
          return partial(match, groups, placeholderFor(name));
        });
      }
    }

    // 3. Values the author named as credentials.
    if (assignments) text = redactAssignments(text, placeholderFor, note);

    // 4. Opt-in: anything else that looks random.
    if (entropy) text = redactEntropyRuns(text, placeholderFor, note);

    if (home) text = normalizeHomePaths(text, home);

    return { text, findings };
  }

  /**
   * Redact every string in a document, preserving its structure.
   *
   * Object KEYS are left alone: a key is schema, and rewriting it would break
   * whatever consumes the document. If a key name is itself sensitive, the
   * shape is wrong and redaction is the wrong fix.
   *
   * @returns {{ value: any, findings: Record<string, number>, count: number }}
   */
  function redact(doc) {
    const findings = Object.create(null);
    // The ANCESTOR path, not every node ever visited. A document may legally
    // reference the same object twice (two steps sharing one tool-call record);
    // that is a DAG, not a cycle, and treating it as one would refuse a
    // perfectly exportable trajectory.
    const path = new Set();

    const merge = (found) => {
      for (const [k, n] of Object.entries(found)) findings[k] = (findings[k] || 0) + n;
    };

    const walk = (node, depth) => {
      if (depth > MAX_DEPTH) throw new RangeError("document nested too deeply to redact");
      if (typeof node === "string") {
        const { text, findings: f } = redactText(node);
        merge(f);
        return text;
      }
      if (node === null || typeof node !== "object") return node;
      // A cycle would loop forever; refusing is the safe answer, since the
      // caller drops the payload on a throw.
      if (path.has(node)) throw new TypeError("document contains a cycle");
      path.add(node);
      try {
        if (Array.isArray(node)) return node.map((v) => walk(v, depth + 1));
        const out = {};
        for (const [k, v] of Object.entries(node)) out[k] = walk(v, depth + 1);
        return out;
      } finally {
        path.delete(node);
      }
    };

    // Size is checked on the serialized form because that is what would leave
    // the machine, and because a deep object can be small in memory and vast
    // on the wire. A document that cannot be serialized at all is one a
    // collector could never accept either, so the failure belongs here — and
    // `walk` reports a cycle in the caller's own vocabulary rather than
    // letting JSON's message escape.
    let approx;
    if (typeof doc === "string") approx = doc.length;
    else {
      try {
        approx = JSON.stringify(doc ?? null).length;
      } catch {
        walk(doc, 0); // throws the precise reason (cycle, depth, …)
        throw new TypeError("document cannot be serialized");
      }
    }
    if (approx > MAX_BYTES) throw new RangeError("document too large to redact");

    const value = walk(doc, 0);
    const count = Object.values(findings).reduce((a, b) => a + b, 0);
    return { value, findings, count };
  }

  return { redact, redactText };
}
