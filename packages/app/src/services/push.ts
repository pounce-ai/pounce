/**
 * Push notifications are deferred until APNs credentials are configured (the
 * package is omitted from the build so it doesn't force a push entitlement that
 * blocks signing). These are no-ops; the bridge's push watcher stays idle with
 * no registered tokens. Re-add expo-notifications + creds to enable.
 */

export async function registerForPush(): Promise<void> {
  // no-op until push is enabled
}

export function attachPushNavigation(): () => void {
  return () => {};
}
