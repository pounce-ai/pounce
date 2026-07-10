/**
 * Local notifications for conditions the user must act on — e.g. the bridge is
 * reachable but the agent daemon returned nothing, so their threads vanished.
 *
 * Local-only: we never request an Expo push token, so this needs no APNs
 * credentials or push entitlement (that's why remote push in ./push stays a
 * stub). All calls degrade to no-ops if the native module or permission is
 * unavailable, so callers never have to guard.
 */
import * as Notifications from "expo-notifications";

let initialized = false;
const lastFired = new Map<string, number>();

/**
 * Install the foreground presentation handler and request permission (once).
 * We show banners even while foregrounded because the user is usually staring at
 * the very screen the alert explains.
 */
export async function initLocalNotifications(): Promise<void> {
  if (initialized) return;
  initialized = true;
  try {
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: false,
        shouldSetBadge: false,
      }),
    });
    const { status } = await Notifications.getPermissionsAsync();
    if (status !== "granted") await Notifications.requestPermissionsAsync();
  } catch {
    // Native module not in this build yet — stays a no-op.
  }
}

/**
 * Fire a local notification, at most once per `cooldownMs` for a given `key`, so
 * a polling loop (e.g. the 25s live sync) can call it every tick without
 * spamming. Reset with {@link clearNotify} when the condition recovers.
 */
export async function notifyOnce(
  key: string,
  title: string,
  body: string,
  cooldownMs = 10 * 60_000,
): Promise<void> {
  const now = Date.now();
  if (now - (lastFired.get(key) ?? 0) < cooldownMs) return;
  lastFired.set(key, now);
  try {
    await initLocalNotifications();
    await Notifications.scheduleNotificationAsync({ content: { title, body }, trigger: null });
  } catch {
    lastFired.delete(key); // let a real retry through once the module lands
  }
}

/** Forget a key so its next occurrence notifies immediately (condition cleared). */
export function clearNotify(key: string): void {
  lastFired.delete(key);
}
