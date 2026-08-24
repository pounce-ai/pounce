/**
 * Known-format credential patterns — the high-precision layer.
 *
 * Every rule here matches a credential whose SHAPE is published by whoever
 * issues it, which is why this layer can run with no entropy gate and
 * effectively no false positives: `sk-ant-…` is never anything but an
 * Anthropic key. That precision is the point. The layers above this one
 * (key-name assignments, the machine denylist) trade precision for reach;
 * this one is the part you can enable everywhere without argument.
 *
 * ORDER MATTERS. Rules run top to bottom against the same string, so the
 * specific form goes before the general one that would also match it —
 * `sk-ant-…` before the bare `sk-…` of an OpenAI key, `github_pat_…` before
 * the shorter `ghp_…`. Getting this backwards doesn't leak anything (both
 * redact), but it mislabels the finding, and the label is what a reviewer
 * reads to decide whether the ruleset is working.
 *
 * A rule's `name` lands in the placeholder — `[redacted:anthropic-key]` — so
 * it must describe the KIND and never carry any part of the value.
 */

/** @typedef {{ name: string, re: RegExp }} Rule */

/** @type {Rule[]} */
export const PATTERNS = [
  // A private key is the highest-value thing in this list and the only one
  // that spans lines, so it runs first — before any single-line rule can
  // chew a hole in the middle of the block and break the end delimiter.
  {
    name: "private-key",
    re: /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/g,
  },

  // Provider keys, most specific prefix first.
  { name: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  { name: "openai-key", re: /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { name: "github-pat", re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { name: "github-token", re: /\bgh[posru]_[A-Za-z0-9]{20,}/g },
  { name: "aws-access-key-id", re: /\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g },
  { name: "google-api-key", re: /\bAIza[A-Za-z0-9_-]{35}\b/g },
  { name: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: "stripe-key", re: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { name: "sendgrid-key", re: /\bSG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g },
  { name: "npm-token", re: /\bnpm_[A-Za-z0-9]{30,}/g },

  // A JWT is frequently the session credential in a pasted curl, and its three
  // base64url segments are distinctive enough to match on shape alone.
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },

  // Credentials carried by transport rather than by literal: the password in a
  // connection string, and the token on an Authorization header. Both show up
  // constantly in agent conversations because both belong to commands that get
  // pasted verbatim.
  {
    name: "url-credentials",
    re: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+):[^\s@/]{3,}@/g,
  },
  { name: "bearer-token", re: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g },
  { name: "npmrc-auth", re: /_authToken\s*=\s*\S+/g },
];

/**
 * `url-credentials` keeps the scheme and user and drops only the password —
 * `postgres://app:hunter2@db` becomes `postgres://app:[redacted:…]@db`. The
 * host is what makes the finding actionable in a bug report, and it isn't the
 * secret. Every other rule replaces its whole match.
 */
export const PARTIAL = {
  "url-credentials": (match, groups, placeholder) => `${groups[0]}:${placeholder}@`,
};
