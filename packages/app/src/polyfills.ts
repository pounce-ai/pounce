/**
 * Runtime polyfills — imported FIRST at the app entry (before anything touches
 * @tanstack/db). Hermes ships no global `crypto`, and @tanstack/db's
 * `safeRandomUUID` throws without `crypto.randomUUID`/`crypto.getRandomValues`.
 * It only needs these for INTERNAL transaction ids (never for our data keys,
 * which are all explicit), so a Math.random-based `getRandomValues` is a
 * sufficient, dependency-free fill — no native module, no rebuild. If a real
 * crypto is present (a future Hermes, a native polyfill), we leave it alone.
 */
const g = globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } };
if (!g.crypto || typeof g.crypto.getRandomValues !== "function") {
  g.crypto = {
    ...g.crypto,
    getRandomValues: (arr: Uint8Array): Uint8Array => {
      for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256);
      return arr;
    },
  };
}
