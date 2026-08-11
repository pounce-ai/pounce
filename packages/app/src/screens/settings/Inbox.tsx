/**
 * Settings → Inbox. How long a thread may sit quiet before it settles itself.
 *
 * The sidebar clears finished work out of the active list, but settling is an
 * explicit gesture with no backfill — so on a machine with a year of history
 * the inbox would open with every thread in it. This is the setting that makes
 * it usable on day one, which is why it defaults to on.
 */
import { View } from "react-native";
import { useUnistyles } from "react-native-unistyles";
import { useSelector } from "@legendapp/state/react";
import { PounceIcon } from "../../ui/native/Icon";
import { autoSettleDays$ } from "../../state/settledStore";
import { AUTO_SETTLE_DEFAULT_DAYS } from "../../state/settled";
import { settingsTitle } from "./routes";
import {
  SettingsCaption,
  SettingsPage,
  SettingsRow,
  SettingsSection,
} from "../../components/settings/primitives";

/** Offered windows. Short ones are the point — the list is meant to be a few
 *  days of live work, not a filing cabinet. */
const CHOICES: readonly (number | null)[] = [1, AUTO_SETTLE_DEFAULT_DAYS, 7, 14, 30, null];

const label = (days: number | null) =>
  days == null
    ? "Never — I'll settle them myself"
    : days === 1
      ? "After a day"
      : `After ${days} days`;

export default function InboxScreen() {
  const { theme } = useUnistyles();
  const current = useSelector(() => autoSettleDays$.get());

  return (
    <SettingsPage title={settingsTitle("inbox")} chrome="modal">
      <SettingsSection title="Settle quiet threads">
        {CHOICES.map((days, i) => (
          <SettingsRow
            key={String(days)}
            label={label(days)}
            value={days === AUTO_SETTLE_DEFAULT_DAYS ? "Default" : undefined}
            onPress={() => autoSettleDays$.set(days)}
            divided={i > 0}
            accessory={
              current === days ? (
                <PounceIcon name="checkmark" size={17} color={theme.colors.accent} />
              ) : (
                <View />
              )
            }
          />
        ))}
      </SettingsSection>
      <SettingsCaption>
        A thread with no activity for this long drops into Settled on its own. Anything that needs
        you — a question, a failure, a running turn — stays in the list however old it is, and any
        new activity brings a settled thread straight back.
      </SettingsCaption>
    </SettingsPage>
  );
}
