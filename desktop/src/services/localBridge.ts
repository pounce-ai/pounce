/**
 * Local bridge auto-pairing.
 *
 * The desktop app ships with the bridge; on this machine it listens on
 * 127.0.0.1:8099. The bridge's loopback-only `/ui` endpoint returns its pairing
 * token, so the app can add itself as a device with zero configuration — no QR
 * scan, no manual token entry. Other machines' bridges are still added the
 * mobile way (Settings → add device).
 */
import { addDeviceConfig, adoptBridgeToken, listDeviceConfigs } from "@pounce/app/services/bridge";

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

/**
 * Add the local bridge as a device — and keep its token honest.
 *
 * `/ui` is loopback-only and unauthenticated, so it is the one place a client
 * can learn a bridge's CURRENT token without already holding a working one.
 * This used to return early once a device existed, which meant the stored copy
 * was never checked against it again. Anything that gives the bridge a new
 * token behind the app's back — reinstalling, clearing ~/.pounce, or rolling
 * back to a bridge from before tokens were minted — then locked the app out of
 * its own machine permanently: every call 401s, `/v1/token` needs the
 * credential that's wrong, and the app reports "0 devices online" while the
 * bridge is running perfectly well two inches away.
 */
export async function ensureLocalBridge(): Promise<boolean> {
  try {
    const devices = await listDeviceConfigs();
    const configured = devices.some((d) => d.url === LOCAL_URL);
    const res = await fetchWithTimeout(`${LOCAL_URL}/ui`, 2500);
    // Bridge not answering: keep whatever is configured rather than treating
    // silence as evidence the pairing is wrong.
    if (!res.ok) return configured;
    const { token } = (await res.json()) as { token?: string };
    if (!token) return configured;
    if (configured) await adoptBridgeToken(LOCAL_URL, token);
    else await addDeviceConfig(LOCAL_URL, token);
    return true;
  } catch {
    // Bridge not up yet — bootstrap continues with whatever is configured;
    // a later refresh picks the local bridge up once it's listening.
    return false;
  }
}
