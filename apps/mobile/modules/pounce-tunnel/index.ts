/**
 * pounce-tunnel — start/stop the in-app Iroh loopback proxy.
 *
 * `start` spins up a 127.0.0.1:<port> listener inside the app whose every
 * connection rides QUIC to the paired Mac's pounce-tunnel. Point HTTP at the
 * returned port and the whole bridge API works exactly as on the LAN.
 * Loading is defensive: on platforms/builds without the native module
 * (web, desktop, Expo Go) `isTunnelAvailable()` is simply false.
 */
import { requireNativeModule } from "expo-modules-core";

type NativeTunnel = {
  start(nodeId: string, relay: string | null, token: string): Promise<number>;
  stop(): void;
};

let native: NativeTunnel | null = null;
try {
  native = requireNativeModule<NativeTunnel>("PounceTunnel");
} catch {
  native = null;
}

export function isTunnelAvailable(): boolean {
  return native != null;
}

/** Returns the local port to use as `http://127.0.0.1:<port>`. Throws with the
 *  Rust-side error message on failure. Idempotent per (nodeId, relay, token). */
export async function startTunnel(nodeId: string, relay: string | null, token: string): Promise<number> {
  if (!native) throw new Error("PounceTunnel native module not in this build");
  return native.start(nodeId, relay, token);
}

export function stopTunnel(): void {
  native?.stop();
}
