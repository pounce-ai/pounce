/**
 * One app version, stamped into every manifest that carries it.
 *
 * Pounce ships the same product four ways — the phone app, the macOS desktop
 * app, and the Electrobun app for Windows and Linux — and until this script
 * existed each one carried its own number: mobile 1.5.0, macOS desktop 1.0.46,
 * Electrobun 1.2.0. Nothing enforced any relationship between them, so the
 * GitHub releases page listed "Pounce Desktop 1.0.46" and "Pounce v1.2.0" side
 * by side and nobody could tell which was newer, or that they were the same
 * product. version.json is now the only place the number is decided.
 *
 * The tunnel (apps/tunnel) and the npm CLI (apps/cli) are deliberately NOT
 * here. They are consumed independently — a crate and an npm package with their
 * own compatibility stories — so dragging them to the app's number would make
 * their versions say nothing about what changed in them.
 *
 * ONE build counter is not left alone: CFBundleVersion. Sparkle compares THAT,
 * not the version users read, to decide whether an update exists — so a release
 * shipping a new CFBundleShortVersionString with the old CFBundleVersion is
 * invisible to every installed Mac. It used to be bumped by hand on each
 * `desktop-v*` release PR; unified releases (#165) retired those PRs and nothing
 * inherited the step, so it sat at 47 through 1.5.1, 1.5.2, 1.6.0 and 1.6.1 and
 * macOS auto-update quietly stopped working. A counter that must advance on
 * every release belongs to the command that runs on every release.
 *
 * iOS buildNumber and Android versionCode ARE still left alone: those are
 * per-upload counters owned by the stores, and a rejected build burns one
 * without any version change.
 *
 * Usage:
 *   node scripts/set-app-version.mjs 1.5.1   # stamp
 *   node scripts/set-app-version.mjs --check # verify (CI); exit 1 on drift
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION_FILE = path.join(REPO_ROOT, "version.json");

const file = (relative) => path.join(REPO_ROOT, relative);

/**
 * Every manifest carrying the app version, as a read/replace pair.
 *
 * These are regex edits rather than structured writes on purpose: Info.plist is
 * XML whose key ordering matters to nobody but diffs, and electrobun.config.ts
 * is TypeScript. Parsing and re-emitting either would reformat the whole file
 * and bury the one-line change. Each pattern is anchored tightly enough that it
 * matches once, and `stamp` fails loudly if it doesn't.
 */
const TARGETS = [
  {
    label: "phone app",
    path: file("apps/mobile/app.json"),
    // The first "version" under expo — not runtimeVersion, not any nested one.
    pattern: /("expo"\s*:\s*\{[\s\S]*?"version"\s*:\s*")([^"]+)(")/,
  },
  {
    label: "macOS desktop app",
    path: file("desktop/macos/PounceDesktop-macOS/Info.plist"),
    // CFBundleShortVersionString is the version users read; CFBundleVersion,
    // the build counter directly below it, is what Sparkle actually compares —
    // see bumpMacBuild.
    pattern: /(<key>CFBundleShortVersionString<\/key>\s*\n\s*<string>)([^<]+)(<\/string>)/,
  },
  {
    label: "Windows/Linux app (package.json)",
    path: file("bridge-desktop/package.json"),
    pattern: /("version"\s*:\s*")([^"]+)(")/,
  },
  {
    label: "Windows/Linux app (electrobun.config.ts)",
    path: file("bridge-desktop/electrobun.config.ts"),
    // Scoped to the `app:` block so a version elsewhere in the config can never
    // be the one that matches.
    pattern: /(app\s*:\s*\{[\s\S]*?version\s*:\s*")([^"]+)(")/,
  },
];

const MAC_PLIST = file("desktop/macos/PounceDesktop-macOS/Info.plist");
const MAC_BUILD_PATTERN = /(<key>CFBundleVersion<\/key>\s*\n\s*<string>)(\d+)(<\/string>)/;

/** The macOS build counter, as an integer. */
function macBuild() {
  const match = readFileSync(MAC_PLIST, "utf8").match(MAC_BUILD_PATTERN);
  if (!match) {
    throw new Error(
      "macOS: no numeric CFBundleVersion in desktop/macos/PounceDesktop-macOS/Info.plist\n" +
        "the file's shape changed — update MAC_BUILD_PATTERN in scripts/set-app-version.mjs",
    );
  }
  return Number(match[2]);
}

/**
 * Advance the macOS build counter by one.
 *
 * Sparkle's comparator reads `sparkle:version`, generated from the built app's
 * CFBundleVersion, and treats an equal value as "no update available". So this
 * has to move on every release, and it has to move MONOTONICALLY: advertising a
 * build the installed app already claims offers nothing, and advertising one
 * higher than the DMG actually installs is worse — the update then re-offers
 * itself forever.
 */
function bumpMacBuild() {
  const source = readFileSync(MAC_PLIST, "utf8");
  const from = macBuild();
  const to = from + 1;
  writeFileSync(MAC_PLIST, source.replace(MAC_BUILD_PATTERN, `$1${to}$3`));
  return { from, to };
}

function readTarget(target) {
  const source = readFileSync(target.path, "utf8");
  const match = source.match(target.pattern);
  if (!match) {
    throw new Error(
      `${target.label}: no version found in ${path.relative(REPO_ROOT, target.path)}\n` +
        `the file's shape changed — update the pattern in scripts/set-app-version.mjs`,
    );
  }
  return { source, match };
}

function stamp(version) {
  const changes = [];
  for (const target of TARGETS) {
    const { source, match } = readTarget(target);
    const current = match[2];
    if (current !== version) {
      writeFileSync(target.path, source.replace(target.pattern, `$1${version}$3`));
    }
    changes.push({ target, current });
  }

  const manifest = JSON.parse(readFileSync(VERSION_FILE, "utf8"));
  const previous = manifest.app;
  manifest.app = version;
  writeFileSync(VERSION_FILE, `${JSON.stringify(manifest, null, 2)}\n`);

  // Only on a real version change: re-stamping the same number (repairing a
  // drift, re-running the command) must not hand out a build the shipped DMG
  // does not carry.
  const build = previous === version ? null : bumpMacBuild();

  console.log(`  Pounce ${version}\n`);
  for (const { target, current } of changes) {
    const state = current === version ? "already" : `${current} →`;
    console.log(`  ${state.padStart(9)} ${version}  ${target.label}`);
  }
  if (build) {
    console.log(`  ${String(build.from).padStart(9)} → ${build.to}  macOS build (CFBundleVersion)`);
    console.log(
      "\n  The macOS build counter moved with it — Sparkle compares THAT, so a\n" +
        "  release that leaves it alone is invisible to installed Macs.\n" +
        "  iOS buildNumber and Android versionCode stay per-upload, as usual.",
    );
  } else {
    console.log(
      `\n  Already ${version} — the macOS build counter stays at ${macBuild()}, since\n` +
        "  the shipped DMG carries that number and nothing new is being released.",
    );
  }
}

function check() {
  const expected = JSON.parse(readFileSync(VERSION_FILE, "utf8")).app;
  const drifted = [];
  for (const target of TARGETS) {
    const { match } = readTarget(target);
    if (match[2] !== expected) drifted.push({ target, found: match[2] });
  }

  if (drifted.length === 0) {
    console.log(`  every manifest agrees on Pounce ${expected}`);
    return;
  }

  console.error(`version.json says ${expected}, but:\n`);
  for (const { target, found } of drifted) {
    console.error(
      `  ${found.padStart(9)}  ${target.label} (${path.relative(REPO_ROOT, target.path)})`,
    );
  }
  console.error(`\nrun: bun run version:set ${expected}`);
  process.exit(1);
}

const arg = process.argv[2];
if (arg === "--check") {
  check();
} else if (arg && /^\d+\.\d+\.\d+$/.test(arg)) {
  stamp(arg);
} else {
  console.error(
    "usage: node scripts/set-app-version.mjs <major.minor.patch>\n" +
      "       node scripts/set-app-version.mjs --check",
  );
  process.exit(1);
}
