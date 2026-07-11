/**
 * Secure key-value seam. Mobile: the OS keychain via expo-secure-store.
 * Desktop overrides this per-platform (see secureStore.desktop.ts) because
 * expo-secure-store has no macOS/Windows implementation.
 */
export { getItemAsync, setItemAsync, deleteItemAsync } from "expo-secure-store";
