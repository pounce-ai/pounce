/**
 * Talking to the bridge on THIS machine.
 *
 * A handful of features are the owner's own controls — approving a peer's
 * access request, dialling a tunnel, adding a machine over SSH — and the bridge
 * refuses all of them from anywhere but loopback. They also all need the same
 * three things: the loopback URL, the current token, and a fetch that gives up
 * rather than hanging a screen. That lives here so peers.ts and ssh.ts share one
 * copy instead of two that drift.
 */

/** Our own bridge, which is always on this machine. Resolved per call rather
 *  than frozen at import: the port is configuration, and a module-level
 *  constant reads it before anything has had a chance to set it. */
export const local = () => `http://127.0.0.1:${process.env.EXPO_PUBLIC_BRIDGE_PORT ?? "8099"}`;

/** Bare fetch never times out, and a machine that has gone to sleep would hang
 *  the UI forever. Every call here is a foreground interaction, so the waits
 *  are short. */
export async function req<T>(url: string, opts: RequestInit = {}, timeoutMs = 8_000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...opts,
      signal: ctrl.signal,
      headers: { "content-type": "application/json", ...opts.headers },
    });
    const body = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error(body?.error || `${url} -> ${res.status}`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

export const post = <T>(url: string, body: unknown, timeoutMs?: number) =>
  req<T>(url, { method: "POST", body: JSON.stringify(body) }, timeoutMs);

let cachedLocalToken: string | null = null;

/**
 * The owner token for our own bridge.
 *
 * Every owner route is gated on it — being on loopback is not enough, because
 * "approve this stranger's access request" must not be reachable by anything
 * that merely runs on this machine. `/ui` is the one unauthenticated place a
 * client can learn the current token, and it is loopback-only for exactly that
 * reason (localBridge.ts leans on the same property to recover from a rotated
 * token). Cached, and re-fetched once if it turns out to be stale.
 */
export async function localToken(force = false): Promise<string | null> {
  if (cachedLocalToken && !force) return cachedLocalToken;
  try {
    const res = await fetch(`${local()}/ui`);
    if (!res.ok) return null;
    const { token } = (await res.json()) as { token?: string };
    cachedLocalToken = token ?? null;
    return cachedLocalToken;
  } catch {
    return null;
  }
}

/** A call to our own bridge, authenticated, retrying once on a 401 in case the
 *  bridge restarted and minted a new token behind us. */
export async function mine<T>(
  path: string,
  opts: RequestInit = {},
  timeoutMs?: number,
): Promise<T> {
  const attempt = async (force: boolean) => {
    const token = await localToken(force);
    return req<T>(
      `${local()}${path}`,
      { ...opts, headers: { ...opts.headers, authorization: `Bearer ${token ?? ""}` } },
      timeoutMs,
    );
  };
  try {
    return await attempt(false);
  } catch (e) {
    if (!String((e as Error)?.message).includes("unauthorized")) throw e;
    return attempt(true);
  }
}

export const minePost = <T>(path: string, body: unknown) =>
  mine<T>(path, { method: "POST", body: JSON.stringify(body) });
