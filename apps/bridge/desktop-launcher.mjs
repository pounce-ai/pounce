/**
 * Desktop launcher — starts the bridge in-process for the RN desktop app
 * (bundled into its Resources by the "Bundle Pounce Bridge" build phase).
 * The bridge itself runs the native agent host and spawns pounce-tunnel for
 * off-LAN access; nothing else needs bootstrapping.
 */
import { startBridge } from "./server.mjs";

void startBridge({ quiet: false });
