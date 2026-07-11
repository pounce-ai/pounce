/**
 * Local bridge auto-pairing.
 *
 * The desktop app ships with the bridge; on this machine it listens on
 * 127.0.0.1:8099. The bridge's loopback-only `/ui` endpoint returns its pairing
 * token, so the app can add itself as a device with zero configuration — no QR
 * scan, no manual token entry. Other machines' bridges are still added the
 * mobile way (Settings → add device).
 */
import { addDeviceConfig, listDeviceConfigs } from "@litter/app/services/bridge";

export const LOCAL_URL = `http://127.0.0.1:${process.env.EXPO_PUBLIC_BRIDGE_PORT ?? "8099"}`;

export interface LocalBridgeInfo {
  pairUrl: string;
  deepLink: string;
  token: string;
  daemonOk: boolean;
  devices: number;
  connected: boolean;
}

/** Pairing/status info from the local bridge (loopback-only endpoint). */
export async function fetchLocalBridgeInfo(): Promise<LocalBridgeInfo | null> {
  try {
    const res = await fetchWithTimeout(`${LOCAL_URL}/ui`, 4000);
    if (!res.ok) return null;
    return (await res.json()) as LocalBridgeInfo;
  } catch {
    return null;
  }
}

/** The pairing QR as raw SVG markup (rendered by the bridge). */
export async function fetchLocalBridgeQr(): Promise<string | null> {
  try {
    const res = await fetchWithTimeout(`${LOCAL_URL}/qr.svg`, 4000);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  // AbortSignal.timeout isn't available in every Hermes build — do it by hand.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Add the local bridge as a device if it's running and not yet configured. */
export async function ensureLocalBridge(): Promise<boolean> {
  try {
    const devices = await listDeviceConfigs();
    if (devices.some((d) => d.url === LOCAL_URL)) return true;
    const res = await fetchWithTimeout(`${LOCAL_URL}/ui`, 2500);
    if (!res.ok) return false;
    const { token } = (await res.json()) as { token?: string };
    if (!token) return false;
    await addDeviceConfig(LOCAL_URL, token);
    return true;
  } catch {
    // Bridge not up yet — bootstrap continues with whatever is configured;
    // a later refresh picks the local bridge up once it's listening.
    return false;
  }
}
