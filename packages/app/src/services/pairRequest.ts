/**
 * Pairing by asking, instead of by scanning.
 *
 * The phone finds a bridge on the Wi-Fi (services/discovery.ts), asks it to
 * pair, and a human on that machine approves — after which the bridge hands
 * back the same pairing token the QR would have carried. The request route is
 * unauthenticated on purpose and safe for it: an ask is inert until someone
 * clicks Approve, and it shows a 6-digit code on both screens so the person
 * approving can tell this phone from someone else's.
 *
 * See apps/bridge/agents/access.mjs for the other half, and why a `device` ask
 * mints no grant: a grant is read-only by construction, and a phone has to be
 * able to send.
 */
import { Platform } from "react-native";
import { storage } from "./persistence";

export type PairState = "pending" | "approved" | "denied" | "expired" | "revoked";

export interface PairAsk {
  requestId: string;
  claim: string;
  /** Shown on both screens so the approver knows which device is asking. */
  code: string;
}

/**
 * This phone's stable id, minted once and kept.
 *
 * The bridge requires one (it de-duplicates a retrying device's asks by it, so
 * walking away and trying again replaces the card on the approval sheet rather
 * than stacking a second). It identifies the install, nothing about the person.
 */
export function clientId(): string {
  const KEY = "clientId";
  const existing = storage.getString(KEY);
  if (existing) return existing;
  const id = `dev-${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
  storage.set(KEY, id);
  return id;
}

/** What the approval card on the Mac will say is asking. */
function clientName(): string {
  if (Platform.OS === "ios") return "iPhone";
  if (Platform.OS === "android") return "Android phone";
  return "Phone";
}

function requester(appVersion?: string | null) {
  return {
    bridgeId: clientId(),
    hostName: clientName(),
    platform: Platform.OS,
    appVersion: appVersion ?? null,
  };
}

/** Ask a discovered bridge to pair. Throws with a readable message on refusal. */
export async function requestPairing(url: string, appVersion?: string | null): Promise<PairAsk> {
  const res = await fetch(`${url}/v1/access/request`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "device", requester: requester(appVersion) }),
  });
  const body = (await res.json().catch(() => null)) as {
    ok?: boolean;
    requestId?: string;
    claim?: string;
    code?: string;
    error?: string;
    retryAfterMs?: number;
  } | null;
  if (!res.ok || !body?.ok || !body.requestId || !body.claim) {
    // 429 is the bridge's rate limit on unapproved askers — a real user retrying
    // shouldn't read that as a failure of their network.
    if (res.status === 429) throw new Error("That computer is busy — try again in a moment.");
    throw new Error(body?.error || "That computer wouldn't take the request.");
  }
  return { requestId: body.requestId, claim: body.claim, code: body.code ?? "" };
}

export interface PairVerdict {
  state: PairState;
  /** Present exactly once, on the poll that first sees the approval. */
  token?: string;
  /** The tunnel's handshake secret — no longer the same value as `token`, and
   *  issued only to a device approval. Delivered on that same single poll. */
  tunnelToken?: string;
}

/** Has it been approved yet? Authenticated by the claim, not by a token. */
export async function pollPairing(url: string, ask: PairAsk): Promise<PairVerdict> {
  const res = await fetch(
    `${url}/v1/access/request/${ask.requestId}?claim=${encodeURIComponent(ask.claim)}`,
    { cache: "no-store" },
  );
  if (!res.ok) return { state: "expired" };
  const body = (await res.json().catch(() => null)) as {
    state?: PairState;
    token?: string;
    tunnelToken?: string;
  } | null;
  return { state: body?.state ?? "pending", token: body?.token, tunnelToken: body?.tunnelToken };
}
