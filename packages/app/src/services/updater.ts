/**
 * Auto-update seam. Base impl (mobile + Windows): unsupported — mobile ships
 * via EAS OTA, Windows has no Sparkle yet. macOS overrides this
 * (updater.desktop.ts) with a Sparkle bridge.
 */
export async function isUpdaterSupported(): Promise<boolean> {
  return false;
}
export async function isAutoUpdateEnabled(): Promise<boolean> {
  return false;
}
export function setAutoUpdateEnabled(_enabled: boolean): void {}
export function checkForUpdatesNow(): void {}
