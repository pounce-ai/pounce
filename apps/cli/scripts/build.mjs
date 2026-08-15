/**
 * Build dist/launcher.mjs for the npm package: bun-bundle the bridge (server +
 * workspace deps like @pounce/transcript) into one file, keeping every
 * published package external — those are regular npm dependencies of
 * use-pounce, installed by npm/npx and resolved at runtime the normal way.
 * The ACP adapter packages aren't imported statically (the bridge
 * require.resolve()s them), so they only need to exist in dependencies.
 *
 * Runs via `bun scripts/build.mjs` (also wired as prepack, so `npm pack` and
 * `npm publish` always ship a fresh bundle).
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, "..");

// Published packages imported by the bridge source — keep external (zigpty
// also has subpath imports, e.g. zigpty/idle).
const EXTERNAL = [
  "@agentclientprotocol/sdk",
  "@modelcontextprotocol/sdk",
  "@modelcontextprotocol/sdk/*",
  "zod",
  "@wterm/core",
  "qrcode",
  "qrcode-terminal",
  "zigpty",
  "zigpty/*",
];

execFileSync(
  process.env.BUN_BIN || "bun",
  [
    "build",
    path.join(PKG, "src/launcher-entry.mjs"),
    "--target=node",
    ...EXTERNAL.flatMap((e) => ["--external", e]),
    "--outfile",
    path.join(PKG, "dist/launcher.mjs"),
  ],
  { stdio: "inherit", cwd: PKG },
);

// `pounce mcp` — bundled the same way and for the same reason: `files` ships
// only bin/ and dist/, so anything under src/ never reaches the published
// package. The MCP SDK and zod stay external — they're ordinary dependencies
// npm installs and resolves at runtime.
execFileSync(
  process.env.BUN_BIN || "bun",
  [
    "build",
    path.join(PKG, "src/mcp.mjs"),
    "--target=node",
    ...EXTERNAL.flatMap((e) => ["--external", e]),
    "--outfile",
    path.join(PKG, "dist/mcp.mjs"),
  ],
  { stdio: "inherit", cwd: PKG },
);
// `pounce configure` — same story again. Node built-ins only, so nothing here
// is external; it's bundled purely so `files: [bin, dist]` carries it.
execFileSync(
  process.env.BUN_BIN || "bun",
  [
    "build",
    path.join(PKG, "src/configure.mjs"),
    "--target=node",
    ...EXTERNAL.flatMap((e) => ["--external", e]),
    "--outfile",
    path.join(PKG, "dist/configure.mjs"),
  ],
  { stdio: "inherit", cwd: PKG },
);
console.log("built dist/launcher.mjs + dist/mcp.mjs + dist/configure.mjs");
