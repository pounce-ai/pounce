/**
 * Compiled-bridge entrypoint — the target of `bun build --compile`
 * (scripts/bridge/compile.mjs). Bundling this into one executable embeds the
 * Bun runtime, the bridge, zigpty's native addon, and the ACP adapters, so the
 * packaged bridge runs with NO Node/Bun on the host. That's what lets the macOS
 * app work on Intel (no more host-`node` probe) and non-technical users on
 * Windows/Linux run a plain executable.
 *
 * Two modes, chosen by argv:
 *   pounce-bridge                     → run the bridge (default)
 *   pounce-bridge --acp-adapter NAME  → run NAME's ACP adapter over stdio
 *
 * The bridge re-invokes ITSELF for `--acp-adapter` because there's no `node` to
 * run the adapter's .mjs in a compiled build — see agents/acp.mjs spawnSpec(),
 * which switches to `{command: process.execPath, args: ["--acp-adapter", …]}`
 * when POUNCE_COMPILED is set.
 */
process.env.POUNCE_COMPILED = "1";

const flag = process.argv.indexOf("--acp-adapter");
if (flag !== -1) {
  const name = process.argv[flag + 1];
  // Consume our own dispatch args so the adapter sees a clean argv (it inspects
  // process.argv for --cli/--version).
  process.argv.splice(flag, 2);
  // Literal specifiers so Bun bundles both adapters into the binary. Importing
  // the adapter runs its ACP server over stdio (its top-level starts on load).
  if (name === "claude") await import("./adapters-embed/claude.mjs");
  else if (name === "codex") await import("./adapters-embed/codex.mjs");
  else {
    console.error(`[bridge] unknown --acp-adapter: ${name}`);
    process.exit(2);
  }
} else {
  const { startBridge } = await import("./server.mjs");
  void startBridge({ quiet: false });
}
