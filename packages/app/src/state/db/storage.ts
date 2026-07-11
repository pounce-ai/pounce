/**
 * react-db persistence over the shared MMKV instance. TanStack DB's
 * `localStorageCollectionOptions` accepts any synchronous Storage-like object,
 * and MMKV (react-native-mmkv) is synchronous — so it slots straight in as the
 * backing store. React Native has no cross-tab `storage` events, so that hook is
 * a no-op. Every collection persists to its own `db:*` MMKV key.
 */
import { createCollection, localStorageCollectionOptions } from "@tanstack/db";
import { storage as mmkv } from "../../services/persistence";

/** Storage-API shim (getItem/setItem/removeItem) backed by the MMKV instance. */
const mmkvStorageApi = {
  getItem: (key: string): string | null => mmkv.getString(key) ?? null,
  setItem: (key: string, value: string): void => mmkv.set(key, value),
  removeItem: (key: string): void => mmkv.delete(key),
};

/** No cross-context storage events on RN — collections are single-process. */
const noopStorageEvents = {
  addEventListener: (): void => {},
  removeEventListener: (): void => {},
};

/** Define an MMKV-persisted collection uniformly. Keys must be strings. */
export function mmkvCollection<T extends object>(opts: {
  id: string;
  storageKey: string;
  getKey: (item: T) => string;
}) {
  return createCollection(
    localStorageCollectionOptions<T>({
      id: opts.id,
      storageKey: opts.storageKey,
      storage: mmkvStorageApi,
      storageEventApi: noopStorageEvents,
      getKey: opts.getKey,
    }),
  );
}
