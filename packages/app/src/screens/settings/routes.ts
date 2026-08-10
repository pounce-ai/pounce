/**
 * The settings sub-screens, in one place.
 *
 * A screen's title used to be written three times — the mobile stack's
 * `Stack.Screen` options, the shared screen's own `SettingsPage title=`, and
 * (once desktop started drawing modal chrome) the shell's modal table. Renaming
 * one was a three-file edit that no type error would catch, and mobile and
 * desktop could disagree about the same screen.
 *
 * Sizes live here too: they describe the screen, and the shell is just the one
 * host that happens to need them.
 */
export interface SettingsRoute {
  /** Route segment under /settings — also the mobile stack's screen name. */
  readonly name: "devices" | "appearance" | "spend";
  readonly title: string;
  /** Desktop modal card size. */
  readonly width: number;
  readonly height: number;
}

export const SETTINGS_ROUTES: readonly SettingsRoute[] = [
  { name: "devices", title: "Devices", width: 600, height: 640 },
  { name: "appearance", title: "Appearance", width: 560, height: 620 },
  { name: "spend", title: "Official spend", width: 600, height: 560 },
];

/** `/settings/devices` — the href a row navigates to. */
export function settingsHref(name: SettingsRoute["name"]): string {
  return `/settings/${name}`;
}

export function settingsTitle(name: SettingsRoute["name"]): string {
  return SETTINGS_ROUTES.find((r) => r.name === name)?.title ?? "Settings";
}
