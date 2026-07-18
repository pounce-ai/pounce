/**
 * Background entry for the `pounce` CLI: starts the bridge in-process. The CLI
 * spawns this detached (`node dist/launcher.mjs`) with BRIDGE_PORT/BRIDGE_TOKEN
 * in the env and stdio pointed at ~/.pounce/bridge.log.
 *
 * Bundled to dist/launcher.mjs by scripts/build.mjs — workspace-private code
 * (@pounce/transcript, the agents host) is inlined; published packages stay
 * external and resolve from this package's regular npm dependencies.
 */
import { startBridge } from "../../bridge/server.mjs";

void startBridge({ quiet: false, appVersion: process.env.POUNCE_CLI_VERSION || null });
