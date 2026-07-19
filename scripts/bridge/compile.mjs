/**
 * Compile the Pounce bridge into a self-contained, single-file executable with
 * `bun build --compile`. The output embeds the Bun runtime, the bridge, zigpty's
 * native PTY addon, and the ACP adapters — so it runs with NO Node/Bun on the
 * host. This is what makes the macOS app work on Intel (no host-`node` probe)
 * and lets non-technical users on Windows/Linux run a plain executable.
 *
 * Usage:
 *   bun run scripts/bridge/compile.mjs [--target=<bun-target>] [--outfile=<path>] [--minify]
 *
 * --target defaults to the host (`bun`). Cross-targets: bun-darwin-arm64,
 * bun-darwin-x64, bun-linux-x64, bun-linux-arm64, bun-windows-x64.
 *
 * IMPORTANT — native addon arch: Bun embeds the zigpty prebuild resolved at
 * BUILD time, i.e. the build host's platform+arch. So each artifact must be
 * built on a runner whose OS+arch matches its target (the CI matrix does this,
 * mirroring tunnel-release.yml). Cross-compiling e.g. darwin-x64 from an arm64
 * Mac would embed the arm64 .node and break the PTY on Intel.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const ENTRY = path.join(REPO, "apps/bridge/bridge-main.mjs");

const argv = process.argv.slice(2);
// Accepts both `--name=value` and `--name value`; a bare `--name` (no following
// value, e.g. --minify) is a boolean `true`.
const arg = (name) => {
  const i = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i === -1) return undefined;
  const a = argv[i];
  if (a.includes("=")) return a.slice(a.indexOf("=") + 1);
  const next = argv[i + 1];
  return next !== undefined && !next.startsWith("--") ? next : true;
};

const target = arg("target") || "bun";
const minify = !!arg("minify");
// Windows executables need the .exe suffix; default names encode the target so a
// matrix build can drop them side by side.
const isWin = String(target).includes("windows");
const defaultName =
  target === "bun" ? "pounce-bridge" : `pounce-bridge-${String(target).replace(/^bun-/, "")}`;
const outfile =
  arg("outfile") || path.join(REPO, "dist", "bridge", isWin ? `${defaultName}.exe` : defaultName);

mkdirSync(path.dirname(outfile), { recursive: true });

const bun = process.env.BUN_BIN || "bun";
const buildArgs = [
  "build",
  ENTRY,
  "--compile",
  `--target=${target}`,
  ...(minify ? ["--minify"] : []),
  "--outfile",
  outfile,
];

process.stdout.write(
  `\n▸ Compiling bridge → ${path.relative(process.cwd(), outfile) || outfile}  (target: ${target})\n`,
);
execFileSync(bun, buildArgs, { stdio: "inherit", cwd: REPO });

const mb = (statSync(outfile).size / (1024 * 1024)).toFixed(0);
process.stdout.write(`✓ ${outfile}  (${mb} MB)\n`);
