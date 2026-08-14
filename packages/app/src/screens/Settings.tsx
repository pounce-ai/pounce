/**
 * Settings — a list of destinations, and nothing else.
 *
 * Everything that needs room to breathe (pairing a machine, picking a theme,
 * an API key) lives one tap away on its own screen. What's left here is a
 * table of contents you can read top to bottom without scrolling past three
 * differently-shaped panels to find the row you wanted.
 *
 * The screen deliberately holds no state of its own beyond what it needs to
 * label a row: whether we're connected, and how many machines are paired.
 */
import { useSelector } from "@legendapp/state/react";
import { connection$ } from "../state/stores";
import { useDeviceCount } from "../state/db/hooks";
import { SettingsPage, SettingsRow, SettingsSection } from "../components/settings/primitives";
import { UpdateRows } from "../components/settings/UpdateRows";
import { TabHeaderIcon } from "../components/TabHeaderIcon";
import { settingsHref } from "./settings/routes";
import { autoSettleDays$ } from "../state/settledStore";

export default function SettingsScreen() {
  const status = useSelector(() => connection$.status.get());
  const autoDays = useSelector(() => autoSettleDays$.get());
  const deviceCount = useDeviceCount();
  const live = status === "connected";

  // One row, two facts: how many machines you've paired and whether this device
  // can currently reach them. "Not connected" with no count is the honest
  // reading when nothing is paired at all.
  const deviceValue = deviceCount
    ? live
      ? `${deviceCount} connected`
      : `${deviceCount} paired · offline`
    : "Not paired";

  return (
    <SettingsPage title="Settings" chrome="pane">
      <TabHeaderIcon sf="gearshape.fill" md="settings" />
      <SettingsSection title="Devices">
        <SettingsRow
          icon="desktop-outline"
          label="Devices"
          value={deviceValue}
          href={settingsHref("devices")}
        />
      </SettingsSection>

      <SettingsSection title="General">
        <SettingsRow
          icon="color-palette-outline"
          label="Appearance"
          href={settingsHref("appearance")}
        />
        <SettingsRow
          icon="checkmark-circle-outline"
          label="Inbox"
          value={autoDays == null ? "Manual" : `${autoDays}d`}
          href={settingsHref("inbox")}
          divided
        />
        <SettingsRow
          icon="card-outline"
          label="Official spend"
          value={deviceCount ? undefined : "Needs a device"}
          href={settingsHref("spend")}
          divided
        />
      </SettingsSection>

      <SettingsSection title="App">
        <SettingsRow
          icon="medkit-outline"
          label="Diagnostics"
          value={deviceCount ? undefined : "Needs a device"}
          href="/diagnostics"
        />
        <SettingsRow icon="time-outline" label="Sync history" href="/sync-history" divided />
        <SettingsRow icon="help-circle-outline" label="Help & FAQ" href="/help" divided />
        {/* Whether the app updates itself is a fact about the app, not about a
            paired machine — it used to live inside the Devices screen's "This
            Mac" card. Silent on platforms with no updater. */}
        <UpdateRows />
      </SettingsSection>
    </SettingsPage>
  );
}
