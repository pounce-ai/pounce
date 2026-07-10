/**
 * Secure key-value seam — desktop implementation.
 *
 * expo-secure-store has no macOS/Windows build; values land in AsyncStorage.
 * The bridge tokens this stores only grant access to a bridge the user already
 * runs on this machine (or explicitly paired with), but this is still
 * plaintext at rest — a Keychain/Credential-Locker backed store is the
 * intended follow-up.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

const PREFIX = "secure:";

export async function getItemAsync(key: string): Promise<string | null> {
  return AsyncStorage.getItem(PREFIX + key);
}

export async function setItemAsync(key: string, value: string): Promise<void> {
  await AsyncStorage.setItem(PREFIX + key, value);
}

export async function deleteItemAsync(key: string): Promise<void> {
  await AsyncStorage.removeItem(PREFIX + key);
}
