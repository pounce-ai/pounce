/**
 * Runtime service — owns the single PounceRuntime instance. Transport
 * selection lives behind the ./transport seam (Iroh-or-HTTP on mobile,
 * HTTP-only on desktop). Pairing payloads go to the secure store, never MMKV.
 */
import { AppState, Platform } from "react-native";
import * as SecureStore from "./secureStore";
import { PounceRuntime } from "@pounce/runtime";
import type { PairPayload } from "@pounce/shared";
import { connection$, markDevicesOffline, reconcileDevices } from "../state/stores";
import { connectBridge, listDeviceConfigs, loadBridgeConfig } from "./bridge";
import { buildTransport } from "./transport";

const PAIRING_KEY = "pounce.pairing";
const LEGACY_PAIRING_KEY = "litter.pairing"; // pre-Pounce-rename key

let runtime: PounceRuntime | null = null;

export async function getRuntime(): Promise<PounceRuntime> {
  if (runtime) return runtime;
  runtime = PounceRuntime.withTransport(await buildTransport());
  runtime.onConnectionStateChange((s) => connection$.status.set(s));
  return runtime;
}

export async function savePairing(p: PairPayload): Promise<void> {
  await SecureStore.setItemAsync(PAIRING_KEY, JSON.stringify(p));
}

export async function loadPairing(): Promise<PairPayload | null> {
  const raw =
    (await SecureStore.getItemAsync(PAIRING_KEY)) ??
    (await SecureStore.getItemAsync(LEGACY_PAIRING_KEY));
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

/**
 * Refresh the current workspace (live sync if a bridge is configured).
 *
 * Settled overrides ride along here rather than being loaded by whichever
 * screen draws the inbox: they are bridge-owned, so settling on the desktop has
 * to show up on the phone, and hanging the read off the foreground heartbeat
 * means every surface gets the same answer without each one remembering to ask.
 * Fired alongside the thread sync, not after it — neither read depends on the
 * other, and the settle rule tolerates a map that arrives a moment late far
 * better than the user tolerates a slower refresh.
 */
export async function refreshLive(fresh = false): Promise<void> {
  const bridge = await loadBridgeConfig();
  if (!bridge) return; // not paired — nothing to refresh
  const { syncLiveData } = await import("./bridge");
  const { loadSettled } = await import("../state/settledStore");
  try {
    // loadSettled swallows its own failures (a failed read keeps the last known
    // map rather than showing everything as un-settled), so it can't reject.
    await Promise.all([syncLiveData({ fresh }), loadSettled()]);
  } catch {
    /* keep cached */
  }
}

/** How often the foreground heartbeat re-syncs thread activity. */
const FOREGROUND_SYNC_MS = 20_000;
let foregroundSyncStarted = false;

/**
 * Mobile's equivalent of the desktop heartbeat: thread activity decays fast
 * (a short turn never re-syncs on its own), so while the app is foregrounded
 * the workspace re-syncs on a timer — and immediately on background→foreground
 * so stale "Idle" never greets a returning user. Desktop has its own heartbeat
 * (desktop/src/services/heartbeat.ts); this only runs on mobile.
 */
export function startForegroundSync(): void {
  // Web has its own heartbeat too (apps/mobile/WebApp.tsx, mirroring desktop's)
  // — running this alongside it would double the sync cadence.
  if (
    foregroundSyncStarted ||
    Platform.OS === "macos" ||
    Platform.OS === "windows" ||
    Platform.OS === "web"
  ) {
    return;
  }
  foregroundSyncStarted = true;
  let timer: ReturnType<typeof setInterval> | null = null;
  const start = () => {
    timer ??= setInterval(() => void refreshLive(), FOREGROUND_SYNC_MS);
  };
  const stop = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };
  start();
  AppState.addEventListener("change", (s) => {
    if (s === "active") {
      void refreshLive();
      start();
    } else stop();
  });
}

/** App boot: live bridge → paired host (first that succeeds, else disconnected). */
export async function bootstrap(): Promise<void> {
  // Hydrate the react-db collections from MMKV, then one-time import any legacy
  // Legend State data. Both must finish before the first read/sync.
  const { preloadDb } = await import("../state/db/collections");
  const { migrateLegendToDb } = await import("../state/db/migrate");
  await preloadDb();
  migrateLegendToDb();
  startForegroundSync();
  // Persisted `online` is stale until a live sync proves each host reachable —
  // otherwise past pairings show as "connected" on launch even when they're not.
  markDevicesOffline();
  // Sweep any state left behind by devices that are no longer paired (e.g. a
  // machine re-paired under a new URL orphans its old threads). The persisted
  // device configs are the source of truth for what's really paired — but an
  // EMPTY read is ambiguous (genuinely unpaired vs. the keychain not readable
  // this launch, e.g. a background launch before first unlock). Unpairing has
  // its own cleanup path (forgetDevice), so never mass-wipe off an empty list.
  const pairedIds = (await listDeviceConfigs().catch(() => [])).map((d) => d.id);
  if (pairedIds.length) reconcileDevices(pairedIds);
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
