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
