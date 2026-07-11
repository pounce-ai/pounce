/**
 * Desktop connection upkeep. The embedded bridge starts alongside the app and
 * its first daemon probes are cold (empty agents/threads until the Iroh dial
 * warms), so the desktop app re-syncs on a timer instead of relying on
 * pull-to-refresh like mobile: adopt the local bridge as soon as it's up,
 * connect if we aren't, refresh if we are.
 */
import { connectBridge, loadBridgeConfig, syncLiveData } from "@litter/app/services/bridge";
import { connection$ } from "@litter/app/state/stores";
import { ensureLocalBridge } from "./localBridge";

export async function heartbeat(fresh = false): Promise<void> {
  await ensureLocalBridge();
  const bridge = await loadBridgeConfig();
  if (!bridge) return;
  if (connection$.status.get() !== "connected") {
    await connectBridge(bridge);
    return;
  }
  try {
    // Static import on purpose: runtime.refreshLive lazy-imports the bridge
    // module, and in dev Metro serves dynamic imports over HTTP at call time —
    // if the dev server restarts, that import hangs silently on every tick.
    await syncLiveData({ fresh });
  } catch (e) {
    console.warn(`[heartbeat] sync failed: ${String(e)}`);
  }
}
