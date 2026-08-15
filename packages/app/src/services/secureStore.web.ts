/**
 * Secure key-value seam — web implementation.
 *
 * expo-secure-store ships web files, but they are stubs: the first call throws
 * "ExpoSecureStore.default.getValueWithKeyAsync is not a function", which kills
 * loadBridgeConfig during bootstrap before any screen renders.
 *
 * Values land in localStorage. As on desktop (see secureStore.desktop.ts) this
 * is plaintext at rest, and here it is also readable by any script running on
 * the page's origin — so the page must be served by the bridge itself, which is
 * the only origin the bridge answers to anyway (see isOwnOrigin in
 * apps/bridge/server.mjs). Never serve this build from a shared origin.
 */
const PREFIX = "secure:";

/** localStorage throws rather than returning null in private/partitioned modes,
 *  and a bootstrap read must not take the app down with it. */
function store(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export async function getItemAsync(key: string): Promise<string | null> {
  return store()?.getItem(PREFIX + key) ?? null;
}

export async function setItemAsync(key: string, value: string): Promise<void> {
  store()?.setItem(PREFIX + key, value);
}

export async function deleteItemAsync(key: string): Promise<void> {
  store()?.removeItem(PREFIX + key);
}
