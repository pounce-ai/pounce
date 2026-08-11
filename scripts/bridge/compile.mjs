/**
 * Compile the Pounce bridge into a self-contained, single-file executable with
 * `bun build --compile`. The output embeds the Bun runtime, the bridge, and the
 * ACP adapters — so it runs with NO Node/Bun on the host. This is what makes the
 * macOS app work on Intel (no host-`node` probe) and lets non-technical users on
 * Windows/Linux run a plain executable.
 *
 * Usage:
 *   bun run scripts/bridge/compile.mjs [--target=<bun-target>] [--outfile=<path>] [--minify]
 *
 * --target defaults to the host (`bun`). Cross-targets: bun-darwin-arm64,
 * bun-darwin-x64, bun-linux-x64, bun-linux-arm64, bun-windows-x64.
 *
 * IMPORTANT — the native PTY addon is NOT embedded. We used to claim it was;
 * it never was. zigpty computes its addon path at runtime from
 * os.platform()/os.arch() inside a template literal, and Bun's bundler only
 * embeds assets it can resolve statically — so `bun --compile` embedded nothing,
 * and inside the executable `import.meta.url` points at the virtual $bunfs where
 * there is no .node to require. zigpty swallowed that failure, reported
 * `hasNative === false`, and every hosted PTY in the packaged desktop app was
 * silently a pipe rather than a real TTY (and the SSH add-machine flow, which
 * demands a TTY, was simply dead).
 *
 * So we SHIP the addon beside the executable instead, in a `prebuilds/`
 * directory, which our zigpty patch (patches/zigpty@0.2.1.patch) looks in via
 * dirname(process.execPath). Whatever copies the binary must copy that
 * directory with it — the Xcode "Bundle Pounce Bridge" phase and the
 * desktop-release workflow both do.
 *
 * Because the addon travels as a separate file, the prebuild is chosen from the
 * --target, NOT from the build host — cross-compiling e.g. darwin-x64 from an
 * arm64 Mac now ships the x64 .node, as it should. (The executable itself is
 * still whatever Bun cross-compiles.)
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { arch, platform } from "node:os";
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

// zigpty's native PTY addon, shipped beside the binary (see the header note).
// Named for the TARGET, not this machine: `bun-darwin-x64` must get the x64
// .node even when built on an arm64 Mac, or interactive sessions on Intel
// degrade to pipes with no error.
const zigptyPrebuildName = (bunTarget) => {
  // Bun target strings look like `bun-<os>-<arch>[-musl][-baseline|-modern]`;
  // a bare `bun` means "this host". Only os/arch/musl select a prebuild — the
  // baseline/modern CPU variants are about the Bun runtime, not the addon.
  const parts = String(bunTarget)
    .split("-")
    .filter((p) => p !== "baseline" && p !== "modern");
  const [, targetOs = platform(), cpu = arch(), ...rest] = parts;
  const zigOs = { darwin: "darwin", linux: "linux", windows: "win32" }[targetOs];
  if (!zigOs) throw new Error(`unsupported target OS in --target=${bunTarget}`);
  // zigpty only publishes musl builds for linux; there is no darwin/win32 one.
  const musl = zigOs === "linux" && rest.includes("musl") ? "-musl" : "";
  return `zigpty.${zigOs}-${cpu}${musl}`;
};

const prebuildName = zigptyPrebuildName(target);
const prebuildSrc = path.join(REPO, "node_modules/zigpty/prebuilds", `${prebuildName}.node`);
// FAIL, don't warn, and fail BEFORE the (slow) compile. A missing addon yields a
// binary that boots fine and then quietly runs every "interactive" session
// through a pipe — precisely the failure mode that shipped to users, helped
// along by a packer that only printed a warning nobody read.
if (!existsSync(prebuildSrc)) {
  process.stderr.write(
    `\nerror: zigpty prebuild missing for --target=${target}\n` +
      `  expected: ${prebuildSrc}\n` +
      `  Run \`bun install\` (zigpty ships every prebuild in its package).\n` +
      `  Refusing to build a bridge with no real PTY — interactive sessions and\n` +
      `  the SSH add-machine flow would silently degrade.\n`,
  );
  process.exit(1);
}

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

const prebuildDir = path.join(path.dirname(outfile), "prebuilds");
mkdirSync(prebuildDir, { recursive: true });
copyFileSync(prebuildSrc, path.join(prebuildDir, `${prebuildName}.node`));

const mb = (statSync(outfile).size / (1024 * 1024)).toFixed(0);
process.stdout.write(`✓ ${outfile}  (${mb} MB)\n`);
process.stdout.write(`✓ ${path.join(prebuildDir, `${prebuildName}.node`)}  (native PTY addon)\n`);
