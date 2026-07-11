/**
 * Transport selection seam — mobile implementation.
 *
 *   1. IrohTransport (via NitroLitter) when the native module is linked — the
 *      production p2p path.
 *   2. HttpTransport otherwise — works today over LAN / a tunnel, and is the
 *      fallback when running in Expo Go or before the native build exists.
 *
 * Desktop overrides this per-platform (transport.desktop.ts): always HTTP,
 * since @litter/nitro is iOS-only and the bridge runs on the same machine.
 */
import { HttpTransport } from "@litter/runtime";
import type { Transport } from "@litter/runtime";
import * as SecureStore from "./secureStore";

const HTTP_BASE_KEY = "litter.httpBase";

/**
 * Streaming-capable fetch. RN's stock fetch can't expose `response.body` as a
 * ReadableStream, which the SSE event reader needs. react-native-nitro-fetch is
 * a Nitro-backed fetch with true streaming, so we prefer it and fall back to the
 * global fetch (e.g. Expo Go) when the native module isn't linked.
 */
async function resolveFetch(): Promise<typeof fetch> {
  try {
    const { fetch: nitroFetch } = await import("react-native-nitro-fetch");
    return nitroFetch as unknown as typeof fetch;
  } catch {
    return globalThis.fetch;
  }
}

export async function buildTransport(): Promise<Transport> {
  // Lazy import so Expo Go (no native module) doesn't crash at startup.
  try {
    const nitro = await import("@litter/nitro");
    if (nitro.isNitroLitterAvailable()) {
      return new nitro.IrohTransport(nitro.getNitroLitter());
    }
  } catch {
    // native module not present — fall through to HTTP
  }
  const baseUrl =
    (await SecureStore.getItemAsync(HTTP_BASE_KEY)) ?? "http://127.0.0.1:8389";
  return new HttpTransport({ baseUrl, fetchImpl: await resolveFetch() });
}
