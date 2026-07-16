/**
 * Transport selection seam — desktop implementation.
 *
 * Always HTTP: the bridge runs on this machine anyway. Streaming goes through
 * the XHR-backed streamTurn seam, so plain global fetch suffices here.
 */
import { HttpTransport } from "@pounce/runtime";
import type { Transport } from "@pounce/runtime";
import * as SecureStore from "./secureStore";

const HTTP_BASE_KEY = "pounce.httpBase";
const LEGACY_HTTP_BASE_KEY = "litter.httpBase"; // pre-Pounce-rename key

export async function buildTransport(): Promise<Transport> {
  const baseUrl =
    (await SecureStore.getItemAsync(HTTP_BASE_KEY)) ??
    (await SecureStore.getItemAsync(LEGACY_HTTP_BASE_KEY)) ??
    "http://127.0.0.1:8389";
  return new HttpTransport({ baseUrl, fetchImpl: globalThis.fetch });
}
