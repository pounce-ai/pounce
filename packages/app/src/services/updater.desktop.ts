/**
 * Auto-update seam — desktop (macOS). Bridges to PounceUpdater, which wraps
 * Sparkle. Automatic checks stay off until the user opts in (consent modal /
 * Settings toggle). Windows falls through to the base no-op (no Sparkle yet).
 */
import { NativeModules, Platform } from "react-native";

const M = NativeModules.PounceUpdater as
  | {
      isSupported: () => Promise<boolean>;
      isAutomaticEnabled: () => Promise<boolean>;
      setAutomaticEnabled: (enabled: boolean) => void;
      checkForUpdates: () => void;
    }
  | undefined;

export async function isUpdaterSupported(): Promise<boolean> {
  if (Platform.OS !== "macos" || !M) return false;
  try {
    return await M.isSupported();
  } catch {
    return false;
  }
}

export async function isAutoUpdateEnabled(): Promise<boolean> {
  if (!M) return false;
  try {
    return await M.isAutomaticEnabled();
  } catch {
    return false;
  }
}

export function setAutoUpdateEnabled(enabled: boolean): void {
  M?.setAutomaticEnabled(enabled);
}

export function checkForUpdatesNow(): void {
  M?.checkForUpdates();
}
