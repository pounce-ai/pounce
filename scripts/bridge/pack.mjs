/**
 * Pack the Pounce bridge into a self-contained, repo-free bundle that runs on
 * any host with a Node.js runtime — Windows, Linux, or macOS.
 *
 * Mirrors the desktop app's "Bundle Pounce Bridge" Xcode phase: bun-bundle the
 * launcher (server + workspace deps) into one launcher.mjs, bundle the ACP
 * adapters beside it, and ship the one package the bundler can't follow
 * (@anthropic-ai/claude-agent-sdk, dynamically imported) as a sibling
 * node_modules. The result needs only `node` on the target — no repo, no
 * `bun install`. Copies the OS install scripts + README in alongside it.
 *
 * Usage:  bun run scripts/bridge/pack.mjs [outDir]   (default: dist/pounce-bridge)
 * Off-LAN: LAN-only by default. Drop a cross-compiled pounce-tunnel binary at
 * ~/.pounce/bin/ on the host to enable off-LAN access (the bridge auto-detects).
 */
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  chmodSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const OUT = path.resolve(process.argv[2] || path.join(REPO, "dist", "pounce-bridge"));

const bun = process.env.BUN_BIN || "bun";
const run = (args, opts = {}) => execFileSync(bun, args, { stdio: "inherit", cwd: REPO, ...opts });

function step(msg) {
  process.stdout.write(`\n▸ ${msg}\n`);
}

step(`Packing bridge → ${path.relative(process.cwd(), OUT) || OUT}`);
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// 1. Launcher: server.mjs + workspace deps → one file. zigpty is kept external
//    (it loads a native .node the bundler can't follow) and shipped in step 3.
step("Bundling launcher");
run([
  "build",
  path.join(REPO, "apps/bridge/desktop-launcher.mjs"),
  "--target=node",
  "--external",
  "zigpty",
  "--outfile",
  path.join(OUT, "launcher.mjs"),
]);

// 2. ACP adapters (claude, codex) beside the launcher — the bridge spawns these
//    for richer live-turn status when BRIDGE_ACP=1; the stream-json path works
//    without them, so a missing one just disables ACP for that agent.
step("Bundling ACP adapters");
const adaptersDir = path.join(OUT, "adapters");
mkdirSync(adaptersDir, { recursive: true });
for (const pkg of ["claude-agent-acp", "codex-acp"]) {
  const entry = path.join(REPO, "node_modules/@agentclientprotocol", pkg, "dist/index.js");
  if (existsSync(entry)) {
    run(["build", entry, "--target=node", "--outfile", path.join(adaptersDir, `${pkg}.mjs`)]);
  } else {
    console.warn(
      `  ! ${pkg} not found (${entry}) — skipping; ACP for that agent will be unavailable`,
    );
  }
}

// 3. @anthropic-ai/claude-agent-sdk is dynamically imported by the claude
//    adapter — the bundler can't follow it, so ship it as a sibling package.
//    Dependency-free and self-contained.
const sdkSrc = path.join(REPO, "node_modules/@anthropic-ai/claude-agent-sdk");
if (existsSync(sdkSrc)) {
  step("Copying claude-agent-sdk");
  const sdkDst = path.join(adaptersDir, "node_modules/@anthropic-ai/claude-agent-sdk");
  mkdirSync(path.dirname(sdkDst), { recursive: true });
  cpSync(sdkSrc, sdkDst, { recursive: true });
} else {
  console.warn(`  ! claude-agent-sdk not found — claude ACP turns will fail to import`);
}

// 3b. zigpty — the PTY host for interactive (answerable) sessions. Statically
//     imported by the launcher but kept external (native N-API .node prebuilds),
//     so ship it as a sibling package the launcher's `import "zigpty"` resolves.
const zigptySrc = path.join(REPO, "node_modules/zigpty");
if (existsSync(zigptySrc)) {
  step("Copying zigpty (native PTY)");
  cpSync(zigptySrc, path.join(OUT, "node_modules/zigpty"), { recursive: true });
} else {
  console.warn(`  ! zigpty not found — interactive PTY sessions will be unavailable`);
}

// 4. Install/uninstall scripts + README.
step("Adding install scripts");
for (const f of ["install.sh", "uninstall.sh", "install.ps1", "uninstall.ps1", "README.md"]) {
  cpSync(path.join(HERE, f), path.join(OUT, f));
}
for (const f of ["install.sh", "uninstall.sh"]) chmodSync(path.join(OUT, f), 0o755);

// 5. Stamp the bundle with a version (from the desktop app's Info.plist so it
//    tracks the app users already know) for the installer + logs.
let version = "0.0.0";
try {
  const plist = readFileSync(
    path.join(REPO, "desktop/macos/PounceDesktop-macOS/Info.plist"),
    "utf8",
  );
  version =
    plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/)?.[1] ||
    version;
} catch {}
writeFileSync(path.join(OUT, "VERSION"), `${version}\n`);

step(`Done — pounce-bridge ${version}`);
console.log(`
Bundle: ${OUT}
Install on the host:
  • Linux/macOS:  ./install.sh
  • Windows:      powershell -ExecutionPolicy Bypass -File install.ps1
Requires Node.js on the target. LAN-only (off-LAN needs a pounce-tunnel binary).
`);
