/**
 * The two reach layers: named assignments, and (opt-in) bare high-entropy runs.
 *
 * WHY ASSIGNMENTS ARE NOT ENTROPY-GATED. The obvious design is "redact a value
 * if it looks random", and it is wrong in both directions here. `password =
 * hunter2` has the entropy of a dictionary word and is still a password, while
 * a coding-agent transcript is *full* of high-entropy strings that are not
 * secrets: git SHAs, content hashes, UUIDs, base64 images, minified bundles,
 * lockfile integrity fields. So the assignment layer keys off the NAME —
 * something the author already told us is a credential — and redacts the value
 * whatever it looks like.
 *
 * That leaves bare secrets with no name and no known format, which is what
 * `redactEntropyRuns` is for, and it is OFF by default. The default threshold
 * of 4.2 bits/char is set just above hex: a 40-character git SHA tops out at
 * 4.0 because it draws from 16 symbols, so SHAs survive. What does NOT survive
 * is base64 — lockfile integrity hashes, inline data URIs, minified bundles,
 * and anything else that packs 64 symbols per character. In a coding
 * transcript that is a lot of legitimate content, which is why this layer is
 * opt-in and belongs on payloads where a false positive is cheap.
 */

/** Shannon entropy in bits per character. ~4.0+ is where random-looking starts. */
export function shannon(str) {
  if (!str) return 0;
  const freq = new Map();
  for (const ch of str) freq.set(ch, (freq.get(ch) || 0) + 1);
  let bits = 0;
  for (const n of freq.values()) {
    const p = n / str.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * Key names that declare their own value a credential. Deliberately broad on
 * the name and strict on nothing else — the whole precision of this layer
 * comes from the author having written the word "secret" next to it.
 */
const SECRET_KEY =
  /(?:secret|token|passwd|password|pwd|api[_-]?key|apikey|credential|private[_-]?key|access[_-]?key|auth[_-]?(?:key|token)|client[_-]?secret|session[_-]?key)/i;

/**
 * `KEY=value`, `KEY: value`, `"key": "value"` — env files, YAML, JSON and
 * inline shell all at once.
 *
 * The value stops at whitespace, quote, comma or semicolon, which is what
 * keeps `export TOKEN=abc && echo hi` from swallowing the rest of the line.
 * A minimum length avoids redacting `token=1` in a URL builder, and empty or
 * placeholder values are left alone so a redacted doc still shows the shape.
 */
const ASSIGNMENT = new RegExp(
  // 1: key   2: closing key quote + separator + opening value quote   3: value
  // The optional quote before the separator is what makes `"api_key": "…"`
  // work: in JSON the key's own closing quote sits between name and colon.
  String.raw`([A-Za-z_][A-Za-z0-9_.-]*)(["']?\s*[:=]\s*["']?)([^\s"',;}]{8,})`,
  "g",
);

/**
 * An UNQUOTED value is only a credential if it is a flat token-ish blob.
 *
 * This is the rule that keeps the layer usable on a coding transcript. A
 * conversation about auth code is wall-to-wall `token: dev.token`, `let token =
 * conn.accept()`, `const token = str(key, 128) || randomBytes(16)` — every one
 * of them an assignment whose key says "token" and whose value is ordinary
 * source. Redacting those shreds the document and teaches the reader to
 * distrust the placeholder. So an unquoted value must look like a literal
 * secret and not like an expression: no parentheses, no property access, no
 * operators.
 *
 * Real `.env` secrets that fail this test are not lost — they are on this
 * machine, so the denylist layer catches them by exact value. This layer is
 * the backstop for credentials pasted in from somewhere else.
 */
const LITERAL_ISH = /^[A-Za-z0-9_\-+/=]{8,}$/;

/**
 * …and it must not be an IDENTIFIER, which `LITERAL_ISH` alone cannot tell.
 * Rejecting expressions handles `str(key, 128)` and `saved.token`, but a bare
 * `token: LEGACY_TOKEN` or `tunnelToken: freshTunnelSecret` is a single word
 * that passes. Three shapes cover the ways code names things:
 *
 *   SCREAMING_SNAKE   a constant           → LEGACY_TOKEN, TUNNEL_SECRET
 *   snake_case        a variable           → fresh_tunnel_secret
 *   camel / Pascal    a variable, no digit → freshTunnelSecret
 *
 * A credential rarely takes any of those shapes; when it does — an all-lower
 * passphrase, a mixed-case token with digits — it does not match here and is
 * still redacted. This is a heuristic and it will be wrong sometimes in both
 * directions, which is survivable only because the credentials that are
 * genuinely live on this machine are caught by exact value in the denylist
 * layer, not by this one.
 */
const IDENTIFIER_ISH =
  /^(?:[A-Z][A-Z0-9_]*|[a-z][a-z0-9]*(?:_[a-z0-9]+)+|[A-Za-z]*[a-z][A-Z][A-Za-z]*)$/;

/** Values that are obviously not a live credential — leave them readable. */
const PLACEHOLDER =
  /^(?:null|none|undefined|true|false|xxx+|\.\.\.|<[^>]+>|\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*|your[_-]?\w+|example|changeme|redacted|\[redacted[^\]]*\])$/i;

/**
 * Redact the value of any assignment whose KEY names a credential.
 *
 * @param {string} text
 * @param {(name: string) => string} placeholderFor
 * @param {(name: string) => void} onFinding
 */
export function redactAssignments(text, placeholderFor, onFinding) {
  return text.replace(ASSIGNMENT, (match, key, sep, value) => {
    if (!SECRET_KEY.test(key)) return match;
    // A shell/template reference is the NAME of a secret, not one. Checked
    // before PLACEHOLDER because the value regex stops at `}`, so `${VAR}`
    // arrives here as an unterminated `${VAR` that no anchored pattern matches.
    if (value.startsWith("$")) return match;
    if (PLACEHOLDER.test(value)) return match;
    // A quote around the value means someone wrote a literal; without one, the
    // value has to earn it by looking like a credential rather than like code.
    const quoted = /["']$/.test(sep);
    if (!quoted && (!LITERAL_ISH.test(value) || IDENTIFIER_ISH.test(value))) return match;
    onFinding("named-secret");
    return `${key}${sep}${placeholderFor("named-secret")}`;
  });
}

/**
 * Bare runs of high-entropy characters, with no name and no known format.
 *
 * OFF by default — see the module header. `minLength` and `threshold` are the
 * two knobs that decide how much of a `git log` this destroys.
 *
 * @param {string} text
 * @param {(name: string) => string} placeholderFor
 * @param {(name: string) => void} onFinding
 * @param {{ minLength?: number, threshold?: number }} [opts]
 */
export function redactEntropyRuns(text, placeholderFor, onFinding, opts = {}) {
  const { minLength = 24, threshold = 4.2 } = opts;
  const RUN = new RegExp(String.raw`\b[A-Za-z0-9+/_=-]{${minLength},}\b`, "g");
  return text.replace(RUN, (match) => {
    if (shannon(match) < threshold) return match;
    onFinding("high-entropy");
    return placeholderFor("high-entropy");
  });
}
