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
  onChunk: (text: string) => void,
): Promise<void> {
  const f = await streamingFetch();
  const res = await f(url, { method: opts.method ?? "POST", headers: opts.headers, body: opts.body });
  if (!res.ok || !res.body) throw new Error(`turn failed: ${res.status}`);
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const dec = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    onChunk(dec.decode(value, { stream: true }));
  }
}
