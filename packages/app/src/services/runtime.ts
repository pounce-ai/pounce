/**
 * Runtime service — owns the single LitterRuntime instance. Transport
 * selection lives behind the ./transport seam (Iroh-or-HTTP on mobile,
 * HTTP-only on desktop). Pairing payloads go to the secure store, never MMKV.
 */
import * as SecureStore from "./secureStore";
import { LitterRuntime } from "@litter/runtime";
import type { PairPayload } from "@litter/shared";
import { connection$, markDevicesOffline, reconcileDevices } from "../state/stores";
import { connectBridge, listDeviceConfigs, loadBridgeConfig } from "./bridge";
import { buildTransport } from "./transport";

const PAIRING_KEY = "litter.pairing";

let runtime: LitterRuntime | null = null;

export async function getRuntime(): Promise<LitterRuntime> {
  if (runtime) return runtime;
  runtime = LitterRuntime.withTransport(await buildTransport());
  runtime.onConnectionStateChange((s) => connection$.status.set(s));
  return runtime;
}

export async function savePairing(p: PairPayload): Promise<void> {
  await SecureStore.setItemAsync(PAIRING_KEY, JSON.stringify(p));
}

export async function loadPairing(): Promise<PairPayload | null> {
  const raw = await SecureStore.getItemAsync(PAIRING_KEY);
  return raw ? (JSON.parse(raw) as PairPayload) : null;
}

export async function connectSaved(): Promise<boolean> {
  const pairing = await loadPairing();
  if (!pairing) return false;
  const rt = await getRuntime();
  connection$.status.set("connecting");
  try {
    const status = await rt.connect(pairing);
    connection$.activeHostId.set(status.nodeId);
    connection$.demo.set(false);
    return true;
  } catch {
    connection$.status.set("disconnected");
    return false;
  }
}

/** Refresh the current workspace (live sync if a bridge is configured). */
export async function refreshLive(fresh = false): Promise<void> {
  const bridge = await loadBridgeConfig();
  if (!bridge) return; // not paired — nothing to refresh
  const { syncLiveData } = await import("./bridge");
  try { await syncLiveData({ fresh }); } catch { /* keep cached */ }
}

/** App boot: live bridge → paired host (first that succeeds, else disconnected). */
export async function bootstrap(): Promise<void> {
  // Hydrate the react-db collections from MMKV, then one-time import any legacy
  // Legend State data. Both must finish before the first read/sync.
  const { preloadDb } = await import("../state/db/collections");
  const { migrateLegendToDb } = await import("../state/db/migrate");
  await preloadDb();
  migrateLegendToDb();
  // Persisted `online` is stale until a live sync proves each host reachable —
  // otherwise past pairings show as "connected" on launch even when they're not.
  markDevicesOffline();
  // Sweep any state left behind by devices that are no longer paired (e.g. a
  // machine re-paired under a new URL orphans its old threads). The persisted
  // device configs are the source of truth for what's really paired.
  reconcileDevices((await listDeviceConfigs()).map((d) => d.id));
  const bridge = await loadBridgeConfig();
  if (bridge && (await connectBridge(bridge))) {
    const { registerForPush } = await import("./push");
    void registerForPush();
    return;
  }
  const pairing = await loadPairing();
  if (pairing && (await connectSaved())) return;
  // Not paired yet — stay disconnected; the app prompts to sync a device.
  connection$.status.set("disconnected");
}

/** Leave demo mode after a real pairing is saved (forces transport rebuild). */
export function resetRuntime(): void {
  runtime = null;
}
