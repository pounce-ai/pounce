/**
 * Pairing-code parsing, shared by the QR scanner, manual entry (Settings), and
 * the `pounce://connect` deep link (Connect screen).
 *
 * A pairing code is either the deep link
 *   pounce://connect?url=…&token=…[&node=…&relay=…&host=…]
 * or raw JSON `{ url, token, nodeId?, relay?, hostName? }`.
 *
 * `url`+`token` pair over the LAN. The optional `node`/`relay` carry the
 * host's Iroh tunnel identity so one scan also works from any other network:
 * the app saves them as a PairPayload and bridgeBase() dials the tunnel when
 * the LAN address is unreachable — the npx/SSH flow, where the phone may never
 * share a network with the machine at all.
 */

export interface ParsedPairing {
  url: string;
  token: string;
  /** Iroh node id of the host's pounce-tunnel, when the QR carries one. */
  nodeId?: string;
  /** Relay URL for hole-punching (only meaningful with nodeId). */
  relay?: string;
  /** Human label for the host machine, e.g. "dirgha-mbp". */
  hostName?: string;
}

export function parsePairing(data: string): ParsedPairing | null {
  try {
    if (data.startsWith("pounce://")) {
      const u = new URL(data);
      const url = u.searchParams.get("url");
      const token = u.searchParams.get("token");
      if (url && token) {
        return withTunnel(
          { url, token },
          {
            nodeId: u.searchParams.get("node"),
            relay: u.searchParams.get("relay"),
            hostName: u.searchParams.get("host"),
          },
        );
      }
      return null;
    }
    const j = JSON.parse(data) as Partial<ParsedPairing>;
    if (j.url && j.token) {
      return withTunnel({ url: j.url, token: j.token }, j);
    }
  } catch {}
  return null;
}

function withTunnel(
  base: ParsedPairing,
  t: { nodeId?: string | null; relay?: string | null; hostName?: string | null },
): ParsedPairing {
  if (t.nodeId) {
    base.nodeId = t.nodeId;
    if (t.relay) base.relay = t.relay;
    if (t.hostName) base.hostName = t.hostName;
  }
  return base;
}

/** The host label to store with a tunnel pairing: the explicit name when the
 *  code carries one, else the LAN address's host part (better than nothing). */
export function pairingHostName(p: ParsedPairing): string {
  if (p.hostName) return p.hostName;
  try {
    return new URL(p.url).hostname;
  } catch {
    return p.url;
  }
}

/**
 * Pair from a connect link's parameters (`?url=…&token=…[&node=…&relay=…&host=…]`)
 * — the shared core of the mobile /connect screen and the web shell's URL
 * pairing. Saves the tunnel identity first when the link carries one, so the
 * pairing works from any network, then connects. Resolves with whether the
 * bridge answered.
 */
export async function pairFromParams(p: {
  url: string;
  token: string;
  node?: string | null;
  relay?: string | null;
  host?: string | null;
}): Promise<boolean> {
  // Late imports keep this module a leaf for its pure helpers (parse/hostName)
  // — runtime pulls in stores and persistence, which the QR-scan path that
  // only parses must not load.
  const { savePairing } = await import("./runtime");
  const { connectBridge } = await import("./bridge");
  if (p.node) {
    await savePairing({
      nodeId: p.node,
      token: p.token,
      hostName: pairingHostName({ url: p.url, token: p.token, hostName: p.host ?? undefined }),
      relay: p.relay ?? null,
    });
  }
  return connectBridge({ url: p.url, token: p.token });
}
