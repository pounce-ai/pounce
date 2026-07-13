/**
 * Streaming POST seam: POST a turn and deliver response text incrementally.
 *
 * Mobile: react-native-nitro-fetch exposes a real `response.body` stream
 * (RN's stock fetch can't), falling back to global fetch in Expo Go. Desktop
 * overrides this per-platform with an XHR implementation — see
 * streamTurn.desktop.ts.
 */
async function streamingFetch(): Promise<typeof fetch> {
  try {
    const { fetch: nitroFetch } = await import("react-native-nitro-fetch");
    return nitroFetch as unknown as typeof fetch;
  } catch {
    return globalThis.fetch;
  }
}

export async function streamTurn(
  url: string,
  opts: { method?: "GET" | "POST"; headers: Record<string, string>; body?: string },
  onChunk: (text: string) => boolean | void,
): Promise<void> {
  const f = await streamingFetch();
  // `stream: true` is nitro-fetch's opt-in to its real streaming path. Without
  // it, nitroFetch BUFFERS the whole body and replays it as a single chunk once
  // the response completes — the "entire reply appears at once" bug. Standard
  // fetch (the Expo Go fallback) ignores the extra key.
  const res = await f(url, {
    method: opts.method ?? "POST",
    headers: opts.headers,
    body: opts.body,
    stream: true,
  } as RequestInit);
  if (!res.ok || !res.body) throw new Error(`turn failed: ${res.status}`);
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const dec = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    // A truthy return means the caller saw its terminal SSE frame — stop
    // reading now rather than waiting for the transport's close. Break WITHOUT
    // reader.cancel(): nitro-fetch's completion callback close()es the stream
    // unguarded, and closing a cancelled stream throws an UNCAUGHT
    // "stream is not in a state that permits close" (crash in prod). The server
    // ends the response right after the terminal frame, so the stream closes
    // itself; any residual bytes just get dropped with the reader.
    if (onChunk(dec.decode(value, { stream: true }))) break;
  }
}
