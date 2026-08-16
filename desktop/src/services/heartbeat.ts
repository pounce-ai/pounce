/**
 * Desktop connection upkeep. The embedded bridge starts alongside the app and
 * its first daemon probes are cold (empty agents/threads until the Iroh dial
 * warms), so the desktop app re-syncs on a timer instead of relying on
 * pull-to-refresh like mobile: adopt the local bridge as soon as it's up,
 * connect if we aren't, refresh if we are.
 *
 * The web shell (apps/mobile/WebApp.tsx) shares this, passing the page origin
 * as `base` — when the bridge serves the page, /ui is same-origin and the
 * self-adoption works exactly like the desktop loopback case.
 */
import { AppState } from "react-native";
import { connectBridge, loadBridgeConfig, syncLiveData } from "@pounce/app/services/bridge";
import { connection$ } from "@pounce/app/state/stores";
import { ensureLocalBridge } from "./localBridge";

export async function heartbeat(fresh = false, base?: string): Promise<void> {
  await ensureLocalBridge(base);
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

/**
 * The heartbeat cadence, shared by every shell root: eager re-syncs while the
 * bridge/daemon warm up (fresh=1 bypasses the bridge's cache), a steady
 * refresh after, and an immediate sync on (re)activation — timers can stall
 * while the app is inactive, and the window must be fresh the moment the user
 * looks at it. Returns a cleanup for the root's unmount.
 */
export function startHeartbeatCadence(base?: string): () => void {
  const hb = (fresh: boolean) => void heartbeat(fresh, base).catch(() => {});
  const warm = [3_000, 7_000, 12_000, 20_000, 30_000].map((ms) => setTimeout(() => hb(true), ms));
  const steady = setInterval(() => hb(false), 10_000);
  const activation = AppState.addEventListener("change", (state) => {
    if (state === "active") hb(true);
  });
  return () => {
    warm.forEach(clearTimeout);
    clearInterval(steady);
    activation.remove();
  };
}
