/**
 * In-app Iroh tunnel (off-LAN access) — thin, defensive wrapper around the
 * PounceTunnel native module (apps/mobile/modules/pounce-tunnel; Rust core in
 * apps/tunnel). On builds without the module (web, desktop, Expo Go) the
 * wrapper reports unavailable and callers stay LAN-only.
 */

type NativeTunnel = {
  start(nodeId: string, relay: string | null, token: string): Promise<number>;
  stop(): void;
};

let native: NativeTunnel | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { requireNativeModule } = require("expo-modules-core");
  native = requireNativeModule("PounceTunnel");
} catch {
  native = null;
}

export function tunnelAvailable(): boolean {
  return native != null;
}

/** Start (or reuse) the loopback proxy; resolves the local port. Idempotent
 *  per (nodeId, relay, token) — the native side keeps one proxy per peer. */
export async function startTunnel(nodeId: string, relay: string | null, token: string): Promise<number> {
  if (!native) throw new Error("tunnel module not in this build");
  return native.start(nodeId, relay, token);
}

export function stopTunnel(): void {
  try {
    native?.stop();
  } catch {}
}
