/**
 * Local notifications — desktop implementation. expo-notifications has no
 * macOS/Windows build; until a native notifier is wired up (NSUserNotification
 * via a small module, or the bridge's push path), these are quiet no-ops with
 * the same signatures so shared callers don't branch.
 */
export async function initLocalNotifications(): Promise<void> {
  // no-op — nothing to register on desktop yet
}

export async function notifyOnce(
  _key: string,
  _title: string,
  _body: string,
  _cooldownMs = 10 * 60_000,
): Promise<void> {
  // no-op — desktop is usually the machine the agents run on
}

/** Forget a key so its next occurrence notifies immediately (condition cleared). */
export function clearNotify(_key: string): void {}
