/**
 * App update controls, for the Settings → App section.
 *
 * They used to sit inside the "This Mac" card on the Devices screen, which put
 * "should this app update itself?" among the controls for pairing and syncing
 * machines. Updating is a fact about the APP, so it belongs beside Diagnostics
 * and Version rather than under a device.
 *
 * Renders nothing where there is no updater — the mobile seam
 * (services/updater.ts) answers `false`, so phones simply never see these rows.
 */
import { useEffect, useState } from "react";
import { Toggle } from "../Toggle";
import { SettingsRow } from "./primitives";
import {
  checkForUpdatesNow,
  isAutoUpdateEnabled,
  isUpdaterSupported,
  setAutoUpdateEnabled,
} from "../../services/updater";

export function UpdateRows() {
  const [supported, setSupported] = useState(false);
  const [auto, setAuto] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const ok = await isUpdaterSupported();
      if (!alive) return;
      setSupported(ok);
      if (ok) setAuto(await isAutoUpdateEnabled());
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (!supported) return null;

  return (
    <>
      <SettingsRow
        icon="cloud-upload-outline"
        label="Automatic updates"
        divided
        accessory={
          <Toggle
            value={auto}
            onValueChange={(v) => {
              setAuto(v);
              setAutoUpdateEnabled(v);
            }}
            accessibilityLabel="Automatic updates"
          />
        }
      />
      <SettingsRow
        icon="refresh"
        label="Check for updates now"
        divided
        onPress={() => checkForUpdatesNow()}
      />
    </>
  );
}
