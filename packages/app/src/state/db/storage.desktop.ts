/**
 * react-db persistence — desktop implementation.
 *
 * TanStack DB's `localStorageCollectionOptions` needs a SYNCHRONOUS
 * Storage-like object; MMKV provides that on mobile but has no desktop build,
 * and AsyncStorage is (as named) asynchronous. Bridge the gap with a
 * write-behind cache: reads are served synchronously from an in-memory Map,
 * writes update the Map and flush to AsyncStorage in the background. The Map
 * is hydrated from AsyncStorage inside each collection's `preload()` — which
 * `bootstrap()` awaits before the first read or sync — so persisted rows are
 * in place before anything queries them.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createCollection, localStorageCollectionOptions } from "@tanstack/db";

const cache = new Map<string, string>();

let hydrated: Promise<void> | null = null;
function hydrate(): Promise<void> {
  hydrated ??= (async () => {
    try {
      const keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith("db:"));
      if (!keys.length) return;
      for (const [k, v] of await AsyncStorage.multiGet(keys)) {
        if (v != null) cache.set(k, v);
      }
    } catch {
      // Cold start with no persistence — the local bridge re-syncs within
      // seconds, so an empty cache only costs continuity, not data.
    }
  })();
  return hydrated;
}

const syncStorageApi = {
  getItem: (key: string): string | null => cache.get(key) ?? null,
  setItem: (key: string, value: string): void => {
    cache.set(key, value);
    void AsyncStorage.setItem(key, value).catch(() => {});
  },
  removeItem: (key: string): void => {
    cache.delete(key);
    void AsyncStorage.removeItem(key).catch(() => {});
  },
};

/** No cross-context storage events on RN — collections are single-process. */
const noopStorageEvents = {
  addEventListener: (): void => {},
  removeEventListener: (): void => {},
};

/** Same factory surface as the MMKV implementation; the returned collection's
 *  `preload()` hydrates the cache first so persisted rows are visible. */
export function mmkvCollection<T extends object>(opts: {
  id: string;
  storageKey: string;
  getKey: (item: T) => string;
}) {
  const collection = createCollection(
    localStorageCollectionOptions<T>({
      id: opts.id,
      storageKey: opts.storageKey,
      storage: syncStorageApi,
      storageEventApi: noopStorageEvents,
      getKey: opts.getKey,
    }),
  );
  const preload = collection.preload.bind(collection);
  collection.preload = async () => {
    await hydrate();
    return preload();
  };
  return collection;
}
