/**
 * Fetch the pinned ccusage binary for bundling next to the compiled bridge.
 *
 * ccusage is the bridge's estimated-cost source (apps/bridge/agents/ccusage.mjs).
 * As of v20 it ships as one native executable per platform, published to npm as
 * `@ccusage/ccusage-<platform>` — a ~1.8MB tarball holding a single `bin/`
 * entry, no runtime, no dependencies. So "install" is: download, verify, copy.
 *
 * It's bundled rather than downloaded at runtime because the alternative is a
 * dashboard whose numbers appear some minutes after first launch, on a machine
 * that may be behind a proxy that blocks GitHub. The cost is ~3MB in the DMG.
 *
 * Usage:
 *   node scripts/bridge/fetch-ccusage.mjs --outfile <path> [--target <platform>]
 *
 * --target defaults to the host (e.g. darwin-arm64). Both the tarball AND the
 * extracted binary are checked against pinned digests: the tarball digest fails
 * a tampered download fast, and the binary digest is what lets a rebuild skip
 * the network entirely when the right file is already in place.
 *
 * Bumping the version: change CCUSAGE_VERSION and EVERY digest below in the
 * same edit. Regenerate them with (per platform):
 *   curl -sL https://registry.npmjs.org/@ccusage/ccusage-<p>/-/ccusage-<p>-<v>.tgz -o t.tgz
 *   shasum -a 256 t.tgz
 *   tar -xzOf t.tgz package/bin/ccusage | shasum -a 256
 * Then re-check the JSON contract in agents/ccusage.mjs still holds — it is
 * read from a CLI, not a typed API, and v20 already broke v15's shape once.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const CCUSAGE_VERSION = "20.0.19";

/** sha256 of the published tarball, and of the executable inside it. */
const ASSETS = {
  "darwin-arm64": {
    tar: "bbc6935824efa3e106aa02792ed4e86e185a38a8e2a912218e246b4a06311856",
    bin: "a5f1cc293e23acc5b4fd7465ac5611b1cf373992d1332b3c2740bd10ca6602fe",
  },
  "darwin-x64": {
    tar: "286e3d90b6f5502f034d0870b9f4a3278cd4dcdd275d34cd6b941343c3f0ec54",
    bin: "9c0d2ab284bc59dc1735797b9eceb2d284e5088a1cfff1dfbd35894c4056f4c1",
  },
  "linux-x64": {
    tar: "24ebce74bf088bf3265d5b0a47d210175ca32c0e2435c39b2093daf2457ef81e",
    bin: "e4973b39defbd89afaab591ad91710e1a4ca0fec32244f09c7016263c5af0e46",
  },
  "linux-arm64": {
    tar: "b1cca7c423ff354f6870abce037c10836190652b0cf220cb445a4ae88059549f",
    bin: "c87076d4cf82b7dee6d2907e37e867c35e4e8fba86dcddb41191cd5fe8a907ea",
  },
  "win32-x64": {
    tar: "663260669187a6c1f5200ab71fd43f45ad01efa7c0417cec1baded30f726f608",
    bin: "d12495560a93e7ac5397f3647026fa611508ebfbe3e7a8249e2138ff434a3b67",
  },
  "win32-arm64": {
    tar: "5f472d7865be174cc7779a68ab14febcefe17e4a63c2f65c901aba472f50466f",
    bin: "80e4dfa8868685a93092fbc6bd37a0290e4419bcdeecd3b51602dbb0651c6172",
  },
};

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i === -1) return undefined;
  const a = argv[i];
  if (a.includes("=")) return a.slice(a.indexOf("=") + 1);
  const next = argv[i + 1];
  return next !== undefined && !next.startsWith("--") ? next : true;
};

const target = arg("target") || `${process.platform}-${process.arch}`;
const outfile = arg("outfile");
if (!outfile || outfile === true) {
  process.stderr.write("usage: fetch-ccusage.mjs --outfile <path> [--target <platform>]\n");
  process.exit(2);
}

const asset = ASSETS[target];
if (!asset) {
  // Not fatal by design: an unsupported platform simply gets no estimate, the
  // same outcome as a user who never installs ccusage. Failing the build here
  // would block a port to a platform ccusage hasn't published for.
  process.stdout.write(`ccusage: no pinned build for ${target} — skipping (cost estimates off)\n`);
  process.exit(0);
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

// Already correct? Then this is a no-op — matters for incremental Xcode builds,
// which re-run the phase whenever any input changes.
if (existsSync(outfile) && sha256(readFileSync(outfile)) === asset.bin) {
  process.stdout.write(`ccusage ${CCUSAGE_VERSION} already present at ${outfile}\n`);
  process.exit(0);
}

const pkg = `ccusage-${target}`;
const url = `https://registry.npmjs.org/@ccusage/${pkg}/-/${pkg}-${CCUSAGE_VERSION}.tgz`;
process.stdout.write(`▸ Fetching ccusage ${CCUSAGE_VERSION} (${target})\n`);

const res = await fetch(url, { redirect: "follow" });
if (!res.ok) {
  process.stderr.write(`error: ccusage download failed: HTTP ${res.status} ${url}\n`);
  process.exit(1);
}
const tarball = Buffer.from(await res.arrayBuffer());
if (sha256(tarball) !== asset.tar) {
  process.stderr.write(`error: ccusage tarball checksum mismatch for ${target}\n`);
  process.exit(1);
}

mkdirSync(path.dirname(outfile), { recursive: true });
const tmpTar = `${outfile}.tgz.tmp`;
writeFileSync(tmpTar, tarball);
const entry = target.startsWith("win32") ? "package/bin/ccusage.exe" : "package/bin/ccusage";
// -O writes the member to stdout; capture it rather than extracting a tree we'd
// then have to move and clean up. maxBuffer is raised well past the ~2MB binary.
const bin = execFileSync("tar", ["-xzOf", tmpTar, entry], { maxBuffer: 64 * 1024 * 1024 });
if (sha256(bin) !== asset.bin) {
  process.stderr.write(`error: ccusage binary checksum mismatch for ${target}\n`);
  process.exit(1);
}

const tmp = `${outfile}.tmp`;
writeFileSync(tmp, bin);
chmodSync(tmp, 0o755);
renameSync(tmp, outfile);
try {
  execFileSync("rm", ["-f", tmpTar]);
} catch {}
process.stdout.write(`✓ ${outfile}  (${(bin.length / (1024 * 1024)).toFixed(1)} MB)\n`);
