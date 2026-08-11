/**
 * Settings → Appearance. Two independent axes: the THEME (which palette) and
 * the GROUND it paints on (light, dark, or the system's).
 */
import { View } from "react-native";
import { useUnistyles } from "react-native-unistyles";
import { useSelector } from "@legendapp/state/react";
import { PounceIcon } from "../../ui/native/Icon";
import type { IoniconName } from "../../ui/native/icon-map";
import { appearance$, setAppearance, setTheme, theme$ } from "../../state/appearance";
import { THEMES, themeById } from "../../ui/palettes";
import { useGround } from "../../ui/useThemeHex";
import { ThemeSwatches } from "../../components/ThemePicker";
import { settingsTitle } from "./routes";
import {
  SettingsCaption,
  SettingsPage,
  SettingsRow,
  SettingsSection,
} from "../../components/settings/primitives";

const GROUNDS: { id: "system" | "light" | "dark"; label: string; icon: IoniconName }[] = [
  { id: "system", label: "System", icon: "contrast" },
  { id: "light", label: "Light", icon: "sunny" },
  { id: "dark", label: "Dark", icon: "moon" },
];

export default function AppearanceScreen() {
  const { theme } = useUnistyles();
  // Normalised, not raw: a store written by an older build can hold a theme id
  // this one doesn't have (the retired "system"), and the list must still check
  // the theme actually being painted rather than nothing at all.
  const current = themeById(useSelector(() => theme$.get())).id;
  const mode = useSelector(() => appearance$.get());
  const ground = useGround();

  const check = (on: boolean) =>
    on ? <PounceIcon name="checkmark" size={17} color={theme.colors.accent} /> : <View />;

  return (
    <SettingsPage title={settingsTitle("appearance")}>
      <SettingsSection
        title="Theme"
        caption="Sets the palette the whole app paints with — cards, accents and highlights."
      >
        {THEMES.map((t, i) => (
          <SettingsRow
            key={t.id}
            label={t.label}
            divided={i > 0}
            onPress={() => setTheme(t.id)}
            accessory={check(t.id === current)}
            // The swatches ARE the icon: the choice is made by looking.
            leading={<ThemeSwatches theme={t} ground={ground} size={22} />}
          />
        ))}
      </SettingsSection>

      <SettingsSection
        title="Ground"
        caption="Light or dark. System follows your device, changing with it through the day."
      >
        {GROUNDS.map((g, i) => (
          <SettingsRow
            key={g.id}
            icon={g.icon}
            label={g.label}
            divided={i > 0}
            onPress={() => setAppearance(g.id)}
            accessory={check(mode === g.id)}
          />
        ))}
      </SettingsSection>

      <SettingsCaption>Both settings live on this device only.</SettingsCaption>
    </SettingsPage>
  );
}
