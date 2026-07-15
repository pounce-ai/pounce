/**
 * Transport selection seam — desktop implementation.
 *
 * Always HTTP: the bridge runs on this machine anyway. Streaming goes through
 * the XHR-backed streamTurn seam, so plain global fetch suffices here.
 */
import { HttpTransport } from "@litter/runtime";
import type { Transport } from "@litter/runtime";
import * as SecureStore from "./secureStore";

const HTTP_BASE_KEY = "litter.httpBase";

export async function buildTransport(): Promise<Transport> {
  const baseUrl =
    (await SecureStore.getItemAsync(HTTP_BASE_KEY)) ?? "http://127.0.0.1:8389";
  return new HttpTransport({ baseUrl, fetchImpl: globalThis.fetch });
}
