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

/** Persist an observable under a stable key. */
export function persist<T>(obs$: Observable<T>, key: string): void {
  // Cast at the boundary: syncObservable's param type rejects the generic
  // Observable<T> (variance over the readonly base), but the concrete mutable
  // observables we pass satisfy it at runtime.
  syncObservable(obs$ as Parameters<typeof syncObservable>[0], {
    persist: {
      name: `litter-next/${key}`,
      plugin,
    },
  });
}
