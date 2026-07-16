/**
 * Transport selection seam — mobile implementation.
 *
 * HttpTransport over LAN / a tunnel. (An Iroh p2p path via a NitroLitter native
 * module was explored historically; it never shipped and was superseded by the
 * pounce-tunnel remote path, so transport is HTTP everywhere now.)
 *
 * Desktop overrides this per-platform (transport.desktop.ts): also always HTTP,
 * since the bridge runs on the same machine.
 */
import { HttpTransport } from "@pounce/runtime";
import type { Transport } from "@pounce/runtime";
import * as SecureStore from "./secureStore";

const HTTP_BASE_KEY = "pounce.httpBase";
const LEGACY_HTTP_BASE_KEY = "litter.httpBase"; // pre-Pounce-rename key

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
  const baseUrl =
    (await SecureStore.getItemAsync(HTTP_BASE_KEY)) ??
    (await SecureStore.getItemAsync(LEGACY_HTTP_BASE_KEY)) ??
    "http://127.0.0.1:8389";
  return new HttpTransport({ baseUrl, fetchImpl: await resolveFetch() });
}
