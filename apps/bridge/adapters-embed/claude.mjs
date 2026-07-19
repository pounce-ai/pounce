/**
 * Force the claude ACP adapter into the compiled bridge (bridge-main.mjs routes
 * `--acp-adapter claude` here). Importing the adapter's bin entry starts its ACP
 * server over stdio. Its static `@anthropic-ai/claude-agent-sdk` import comes
 * along in the bundle — the SDK is Bun-compile aware (it extracts its vendored
 * CLI from $bunfs at runtime via ./extractFromBunfs).
 */
import "@agentclientprotocol/claude-agent-acp/dist/index.js";
