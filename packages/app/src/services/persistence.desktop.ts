/**
 * Persistence primitives — desktop implementation (macOS/Windows).
 *
 * react-native-mmkv has no desktop build, so Legend State observables persist
 * through AsyncStorage instead. Hydration is asynchronous (unlike MMKV's
 * synchronous boot hydrate); the stores tolerate an initially-empty state, so
 * the UI simply fills in as tables load.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { syncObservable } from "@legendapp/state/sync";
import { observablePersistAsyncStorage } from "@legendapp/state/persist-plugins/async-storage";
import type { Observable } from "@legendapp/state";

const plugin = observablePersistAsyncStorage({ AsyncStorage });

const KEY_PREFIX = "pounce/";
const LEGACY_KEY_PREFIX = "litter-next/"; // pre-Pounce-rename namespace

// One-time, best-effort migration of persisted keys after the litter→pounce
// rename. Fire-and-forget: if it hasn't finished before a store hydrates, that
// store simply starts empty and re-fills from the bridge (the data is a cache).
void (async () => {
  try {
    const keys = await AsyncStorage.getAllKeys();
    for (const oldKey of keys) {
      if (!oldKey.startsWith(LEGACY_KEY_PREFIX)) continue;
      const newKey = KEY_PREFIX + oldKey.slice(LEGACY_KEY_PREFIX.length);
      if ((await AsyncStorage.getItem(newKey)) != null) continue;
      const value = await AsyncStorage.getItem(oldKey);
      if (value != null) await AsyncStorage.setItem(newKey, value);
    }
  } catch {
    // best-effort — clean installs have nothing to migrate
  }
})();

/**
 * Legacy-migration shim. Mobile exports the raw MMKV instance so the react-db
 * migration can read old Legend State blobs; desktop never had those, so an
 * always-empty stand-in makes the migration a clean no-op.
 */
export const storage = {
  getString: (_key: string): string | undefined => undefined,
  set: (_key: string, _value: string): void => {},
  delete: (_key: string): void => {},
};

/** Persist an observable under a stable key. */
export function persist<T>(obs$: Observable<T>, key: string): void {
  // Cast at the boundary: syncObservable's param type rejects the generic
  // Observable<T> (variance over the readonly base), but the concrete mutable
  // observables we pass satisfy it at runtime.
  syncObservable(obs$ as Parameters<typeof syncObservable>[0], {
    persist: {
      name: `${KEY_PREFIX}${key}`,
      plugin,
    },
  });
}
