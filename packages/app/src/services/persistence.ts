/**
 * Persistence primitives. One MMKV instance shared by Legend State (synchronous,
 * fast, survives restarts) and a helper to wire any observable to it.
 */
import { MMKV } from "react-native-mmkv";
import { syncObservable } from "@legendapp/state/sync";
import { ObservablePersistMMKV } from "@legendapp/state/persist-plugins/mmkv";
import type { Observable } from "@legendapp/state";

export const storage = new MMKV({ id: "pounce" });

// One-time migration from the pre-Pounce-rename store ("litter-next"). Legend
// State persists JSON strings, so a getString copy is lossless; guarded to only
// run into a fresh store, so it's idempotent and a no-op on clean installs.
(() => {
  try {
    if (storage.getAllKeys().length > 0) return;
    const legacy = new MMKV({ id: "litter-next" });
    for (const k of legacy.getAllKeys()) {
      const v = legacy.getString(k);
      if (v !== undefined) storage.set(k, v);
    }
  } catch {
    // best-effort — a fresh install just starts empty
  }
})();

/**
 * Read a persisted observable's value WITHOUT hydrating its store — for the
 * frame before Legend State has hydrated, where waiting would show the wrong
 * thing (the theme unistyles must configure with, before any component renders).
 *
 * Legend State's MMKV plugin is registered with no mmkv config, so it writes to
 * its OWN store (`obsPersist`) rather than the app's. That's the single fact
 * this function exists to hide — pointing the plugin at `storage` instead would
 * orphan every value already persisted on every installed copy of the app.
 */
export function readPersisted(key: string): string | null {
  try {
    legendStore ??= new MMKV({ id: "obsPersist" });
    const raw = legendStore.getString(key) ?? storage.getString(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return null;
  }
}
let legendStore: MMKV | null = null;

/** Persist an observable under a stable key. Hydrates synchronously on boot. */
export function persist<T>(obs$: Observable<T>, key: string): void {
  // Cast at the boundary: syncObservable's param type rejects the generic
  // Observable<T> (variance over the readonly base), but the concrete mutable
  // observables we pass satisfy it at runtime.
  syncObservable(obs$ as Parameters<typeof syncObservable>[0], {
    persist: {
      name: key,
      plugin: ObservablePersistMMKV,
    },
  });
}

/** Secure values (pairing tokens) never go in MMKV plaintext — see secureStore. */
