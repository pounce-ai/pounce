/**
 * Read and promote Google Play tracks from the terminal.
 *
 * `scripts/publish-testflight.sh android` gets a build as far as the internal
 * track. This takes it the rest of the way — internal → production — which was
 * otherwise a click-path through the Play Console every release.
 *
 * The auth is hand-rolled on purpose. The usual routes (`gcloud auth`, python's
 * `google.auth`, googleapis' JWT client) are all absent here, and the whole
 * dance is one RS256 signature: sign a claim set with the service account's
 * private key, trade it for an access token, use the token. No dependency earns
 * its place in that.
 *
 * Three things the Play API will not tell you, each of which has already cost
 * us a release:
 *
 *   - `status: "completed"` means the ROLLOUT is at 100%, not that Google has
 *     finished reviewing. There is no review state anywhere in this response;
 *     its absence is the trap. Never report a promotion as live off this API —
 *     say "submitted at N%" and check the Console.
 *   - Release notes are capped at 500 characters, and going over comes back as
 *     `403 PERMISSION_DENIED` rather than a validation error. Read the message
 *     field before concluding anything about credentials. We check locally so
 *     that never reaches the API.
 *   - A 100% release carries `status: "completed"` and NO `userFraction` field
 *     at all. Sending both is rejected.
 *
 * The listing's own locale is en-IN, but the install base mostly reads en-US
 * and the live release carries both, so notes are written to both. Dropping
 * en-US doesn't error — the notes just quietly don't show for most people.
 *
 * Usage:
 *   node scripts/play-release.mjs status
 *   node scripts/play-release.mjs promote --version-code 21 --notes notes.txt --confirm
 *   node scripts/play-release.mjs promote --version-code 21 --fraction 0.1 --confirm
 */
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE = "com.pounce.app";
const BASE = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE}`;
const TRACKS = ["internal", "alpha", "beta", "production"];
const NOTE_LOCALES = ["en-US", "en-IN"];
const NOTE_LIMIT = 500;

// Gitignored, and it only ever lands in the primary checkout — a fresh worktree
// has to have it copied in before any of this works.
const DEFAULT_KEY = path.join(
  REPO_ROOT,
  "apps/mobile/credentials/google-play-service-account.json",
);

function die(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith("--")) die(`unexpected argument ${arg}`);
    const key = arg.slice(2);
    // Bare flags (--confirm) take no value; everything else consumes the next
    // token.
    if (rest[i + 1] === undefined || rest[i + 1].startsWith("--")) {
      flags[key] = true;
    } else {
      flags[key] = rest[i + 1];
      i += 1;
    }
  }
  return { command, flags };
}

const base64url = (value) =>
  Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

async function accessToken(keyPath) {
  let account;
  try {
    account = JSON.parse(readFileSync(keyPath, "utf8"));
  } catch (error) {
    die(
      `can't read the Play service account at ${keyPath}\n` +
        `copy it in from the primary checkout — it is gitignored, so worktrees never carry it\n` +
        `(${error.message})`,
    );
  }

  const issuedAt = Math.floor(Date.now() / 1000);
  const claims = {
    iss: account.client_email,
    scope: "https://www.googleapis.com/auth/androidpublisher",
    aud: "https://oauth2.googleapis.com/token",
    iat: issuedAt,
    exp: issuedAt + 3600,
  };
  const unsigned = `${base64url({ alg: "RS256", typ: "JWT" })}.${base64url(claims)}`;
  const signature = createSign("RSA-SHA256")
    .update(unsigned)
    .sign(account.private_key, "base64url");

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${signature}`,
    }),
  });
  const body = await response.json();
  if (!body.access_token) die(`token exchange failed: ${JSON.stringify(body)}`);
  return body.access_token;
}

async function api(token, endpoint, init = {}) {
  const response = await fetch(`${BASE}${endpoint}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!response.ok) {
    throw new Error(`${response.status} ${endpoint}: ${JSON.stringify(body)}`);
  }
  return body;
}

/**
 * Reads are scoped to an edit too, even though they mutate nothing — so the
 * edit gets discarded afterwards rather than left dangling against the app.
 */
async function status(token) {
  const edit = await api(token, "/edits", { method: "POST", body: "{}" });
  for (const track of TRACKS) {
    let line;
    try {
      const releases = (await api(token, `/edits/${edit.id}/tracks/${track}`)).releases ?? [];
      line = releases.length
        ? releases
            .map((r) => `${r.name ?? "?"} (vc ${r.versionCodes?.join(", ") ?? "?"}) ${r.status}`)
            .join(", ")
        : "—";
    } catch (error) {
      line = String(error.message).slice(0, 120);
    }
    console.log(`  ${track.padEnd(11)} ${line}`);
  }
  await api(token, `/edits/${edit.id}`, { method: "DELETE" }).catch(() => {});
  console.log(
    "\n  'completed' is the rollout percentage, not the review. Check the Console before calling it live.",
  );
}

async function promote(token, flags) {
  const versionCode = Number(flags["version-code"]);
  if (!Number.isInteger(versionCode)) die("--version-code is required, and must be an integer");

  const track = flags.track ?? "production";
  if (!TRACKS.includes(track)) die(`--track must be one of ${TRACKS.join(", ")}`);

  const fraction = flags.fraction === undefined ? 1 : Number(flags.fraction);
  if (!(fraction > 0 && fraction <= 1)) die("--fraction must be greater than 0 and at most 1");

  let notes = null;
  if (flags.notes) {
    notes = readFileSync(path.resolve(flags.notes), "utf8").trim();
    if (notes.length > NOTE_LIMIT) {
      die(
        `release notes are ${notes.length} characters; Play caps them at ${NOTE_LIMIT}\n` +
          `over the cap the API answers 403 PERMISSION_DENIED, which reads as a credentials problem`,
      );
    }
  }

  const release = {
    versionCodes: [String(versionCode)],
    // A full rollout is 'completed' with userFraction omitted entirely; a
    // partial one is 'inProgress' and carries the fraction.
    ...(fraction === 1
      ? { status: "completed" }
      : { status: "inProgress", userFraction: fraction }),
    ...(notes ? { releaseNotes: NOTE_LOCALES.map((language) => ({ language, text: notes })) } : {}),
  };

  console.log(`  ${PACKAGE} → ${track}`);
  console.log(`  version code ${versionCode} at ${Math.round(fraction * 100)}%`);
  console.log(`  release notes ${notes ? `${notes.length} chars` : "unchanged"}`);
  console.log();

  if (!flags.confirm) {
    console.log(JSON.stringify(release, null, 2));
    console.log("\n  dry run — pass --confirm to commit this to Play.");
    return;
  }

  const edit = await api(token, "/edits", { method: "POST", body: "{}" });
  await api(token, `/edits/${edit.id}/tracks/${track}`, {
    method: "PUT",
    body: JSON.stringify({ track, releases: [release] }),
  });
  await api(token, `/edits/${edit.id}:commit`, { method: "POST" });

  console.log(
    `✓ submitted version code ${versionCode} to ${track} at ${Math.round(fraction * 100)}%`,
  );
  console.log("  Google still has to review it. It is not live until the Console says so.");
}

const { command, flags } = parseArgs(process.argv.slice(2));
const token = await accessToken(flags.key ? path.resolve(flags.key) : DEFAULT_KEY);

if (!command || command === "status") {
  await status(token);
} else if (command === "promote") {
  await promote(token, flags);
} else {
  die(`usage: node scripts/play-release.mjs [status|promote]\nunknown command ${command}`);
}
