/**
 * Pairing-code parsing, shared by the QR scanner, manual entry (Settings), and
 * the `pounce://connect` deep link (Connect screen).
 *
 * A pairing code is either the deep link
 *   pounce://connect?url=…&code=…[&node=…&relay=…&host=…]
 * or raw JSON `{ url, code, nodeId?, relay?, hostName? }`.
 *
 * `code` is a ONE-TIME pairing code, traded once at /v1/device/adopt for this
 * device's own credential. The older `token=` shape carried the bridge's own
 * token, which the phone then replayed in plaintext on every LAN request — one
 * sniffed header was the master credential. Links in that shape are still
 * parsed (an older bridge, or BRIDGE_PAIR_LEGACY_TOKEN=1) but nothing emits
 * them by default any more.
 *
 * `url`+`token` pair over the LAN. The optional `node`/`relay` carry the
 * host's Iroh tunnel identity so one scan also works from any other network:
 * the app saves them as a PairPayload and bridgeBase() dials the tunnel when
 * the LAN address is unreachable — the npx/SSH flow, where the phone may never
 * share a network with the machine at all.
 */

export interface ParsedPairing {
  url: string;
  /** Bearer token, when the link carries the legacy `token=` shape. */
  token?: string;
  /** One-time pairing code, when the link carries the current `code=` shape.
   *  Exactly one of `token`/`code` is set. */
  code?: string;
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
      const code = u.searchParams.get("code");
      if (url && (token || code)) {
        return withTunnel(code ? { url, code } : { url, token: token as string }, {
          nodeId: u.searchParams.get("node"),
          relay: u.searchParams.get("relay"),
          hostName: u.searchParams.get("host"),
        });
      }
      return null;
    }
    const j = JSON.parse(data) as Partial<ParsedPairing>;
    if (j.url && (j.token || j.code)) {
      return withTunnel(j.code ? { url: j.url, code: j.code } : { url: j.url, token: j.token }, j);
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
  token?: string | null;
  code?: string | null;
  node?: string | null;
  relay?: string | null;
  host?: string | null;
}): Promise<boolean> {
  // Late imports keep this module a leaf for its pure helpers (parse/hostName)
  // — runtime pulls in stores and persistence, which the QR-scan path that
  // only parses must not load.
  const { savePairing } = await import("./runtime");
  const { connectBridge, redeemPairCode } = await import("./bridge");

  // Trade the one-time code for this device's own credential BEFORE anything
  // is stored, so the code never lands in persisted config and a failed
  // redemption leaves no half-pairing behind. The tunnel's handshake secret
  // comes back in the same response and nowhere else.
  let token = p.token ?? null;
  let tunnelToken: string | null = null;
  if (p.code) {
    const redeemed = await redeemPairCode(p.url, p.code);
    if (!redeemed) return false;
    token = redeemed.token;
    tunnelToken = redeemed.tunnelToken ?? null;
  }
  if (!token) return false;

  if (p.node) {
    await savePairing({
      nodeId: p.node,
      // The pairing's secret is the tunnel's, which is no longer the bearer
      // token — fall back to it only for a legacy `token=` link, where they
      // are still the same value.
      token: tunnelToken ?? token,
      hostName: pairingHostName({ url: p.url, hostName: p.host ?? undefined }),
      relay: p.relay ?? null,
    });
  }
  return connectBridge({
    url: p.url,
    token,
    ...(p.code ? { adopted: true } : {}),
    ...(tunnelToken ? { tunnelToken } : {}),
  });
}
