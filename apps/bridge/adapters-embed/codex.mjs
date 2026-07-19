/**
 * Force the codex ACP adapter into the compiled bridge (bridge-main.mjs routes
 * `--acp-adapter codex` here). Importing the adapter's bin entry starts its ACP
 * server over stdio. The codex adapter shells out to the user's `codex` CLI, so
 * nothing extra needs embedding.
 */
import "@agentclientprotocol/codex-acp/dist/index.js";
