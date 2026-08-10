/**
 * Finding a bridge on this Wi-Fi, from the phone.
 *
 * The bridge already shouts a beacon onto a multicast group
 * (apps/bridge/agents/discovery.mjs), and the phone cannot hear it: joining a
 * multicast group on iOS needs `com.apple.developer.networking.multicast`, an
 * entitlement Apple grants case by case. So this sweeps the local subnet for
 * the bridge's `/v1/hello` instead — the same facts the beacon broadcasts
 * (name, platform, stable id), no token, no repo names.
 *
 * WHY NOT expo-network. Asking the OS for our own IP would tell us exactly
 * which subnet to sweep, and it is a native module: adding one means this
 * feature can only ship in a store build, while everything here rides an OTA
 * update to phones that already have the app. A short list of the private /24s
 * home and office networks actually use costs a few hundred HEAD-sized requests
 * and reaches every install today.
 *
 * The sweep stops at the first subnet that answers. Bridges live on the network
 * you are on, so a hit means the rest of the list is a waste of radio.
 */
import { loadBridgeConfig } from "./bridge";

export interface FoundBridge {
  /** Stable machine id — the same one paired devices canonicalize on. */
  bridgeId: string;
  hostName: string;
  platform: string;
  /** `http://192.168.1.10:8099` — ready to pair against. */
  url: string;
  appVersion?: string | null;
}

const DEFAULT_PORT = 8099;
/** Enough sockets to sweep a /24 quickly; few enough that iOS doesn't start
 *  refusing them (and the radio isn't saturated for other traffic). */
const CONCURRENCY = 24;
/** A bridge on the same Wi-Fi answers in single-digit milliseconds. This is the
 *  budget for the 250-odd addresses where nothing is listening at all. */
const PROBE_MS = 400;

/**
 * Subnets worth trying, most likely first.
 *
 * A previously paired address goes to the front: the common case for "find my
 * Mac" is a phone that has been on this network before, and starting there
 * usually turns the whole sweep into one hit.
 */
const COMMON = ["192.168.1", "192.168.0", "10.0.0", "10.0.1", "192.168.2", "172.20.10"];

function prefixOf(url: string): string | null {
  const m = /^https?:\/\/(\d+)\.(\d+)\.(\d+)\.\d+/.exec(url);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

async function candidateSubnets(): Promise<string[]> {
  const known = await loadBridgeConfig()
    .then((c) => (c?.url ? prefixOf(c.url) : null))
    .catch(() => null);
  return known ? [known, ...COMMON.filter((c) => c !== known)] : COMMON;
}

/** One address. Resolves to null for the ~253 that aren't a bridge. */
async function probe(
  host: string,
  port: number,
  signal?: AbortSignal,
): Promise<FoundBridge | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PROBE_MS);
  const onAbort = () => ac.abort();
  signal?.addEventListener("abort", onAbort);
  try {
    const url = `http://${host}:${port}`;
    const res = await fetch(`${url}/v1/hello`, { signal: ac.signal, cache: "no-store" });
    if (!res.ok) return null;
    const d = (await res.json()) as Partial<FoundBridge> & { ok?: boolean };
    if (!d?.bridgeId) return null;
    return {
      bridgeId: d.bridgeId,
      hostName: d.hostName || "Computer",
      platform: d.platform || "unknown",
      appVersion: d.appVersion ?? null,
      url,
    };
  } catch {
    return null; // closed port, wrong host, timeout — all the same answer
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Sweep one /24, `CONCURRENCY` sockets at a time. */
async function sweep(prefix: string, port: number, signal?: AbortSignal): Promise<FoundBridge[]> {
  const hosts = Array.from({ length: 254 }, (_, i) => `${prefix}.${i + 1}`);
  const found: FoundBridge[] = [];
  let next = 0;
  const worker = async () => {
    while (next < hosts.length && !signal?.aborted) {
      const host = hosts[next++];
      const hit = await probe(host, port, signal);
      if (hit) found.push(hit);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return found;
}

/**
 * Bridges reachable on this network, or an empty list.
 *
 * Never throws: discovery is an offer, and a phone on cellular (or a locked-down
 * network) should show the pairing code path rather than an error.
 */
export async function discoverBridges({
  port = DEFAULT_PORT,
  signal,
}: { port?: number; signal?: AbortSignal } = {}): Promise<FoundBridge[]> {
  try {
    for (const prefix of await candidateSubnets()) {
      if (signal?.aborted) return [];
      const found = await sweep(prefix, port, signal);
      if (found.length) return found;
    }
  } catch {
    /* fall through to "found nothing" */
  }
  return [];
}
