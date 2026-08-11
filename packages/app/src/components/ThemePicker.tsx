/**
 * Theme picker — one row per theme, each showing the palette it will paint, so
 * the choice is made by looking rather than by reading a name. The compact
 * form, for the desktop shell's titlebar menu; Settings → Appearance renders
 * the same swatch strip in its own rows (see ThemeSwatches).
 */
import { Pressable, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useSelector } from "@legendapp/state/react";
import { setTheme, theme$ } from "../state/appearance";
import { PounceIcon } from "../ui/native/Icon";
import { THEMES, previewSwatches, themeById, type ThemeDefinition } from "../ui/palettes";
import { useGround } from "../ui/useThemeHex";
import type { Appearance } from "../ui/palettes";

/**
 * The four-colour chip for one theme, overlapped so it reads as one palette
 * rather than a row of dots. Drawn in the CURRENT ground: previewing "Ember"
 * while the app is forced light shows Ember's light palette, not its dark one.
 */
export function ThemeSwatches({
  theme,
  ground,
  size = 20,
}: {
  theme: ThemeDefinition;
  ground: Appearance;
  size?: number;
}) {
  return (
    <View style={s.swatches}>
      {previewSwatches(theme, ground).map((color, i) => (
        <View
          key={i}
          style={[
            s.swatch,
            { width: size, height: size, borderRadius: size / 2 },
            i > 0 && { marginLeft: -(size / 3) },
            { backgroundColor: color },
          ]}
        />
      ))}
    </View>
  );
}

export function ThemePicker() {
  // Normalised, not raw: a store written by an older build can hold a theme id
  // this one doesn't have (the retired "system"), and the picker must still
  // show the theme actually being painted rather than no selection at all.
  const current = themeById(useSelector(() => theme$.get())).id;
  const ground = useGround();
  const { theme } = useUnistyles();

  return (
    <View style={s.list} accessibilityRole="radiogroup">
      {THEMES.map((t) => {
        const selected = t.id === current;
        return (
          <Pressable
            key={t.id}
            onPress={() => setTheme(t.id)}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            accessibilityLabel={`${t.label} theme. ${t.blurb}.`}
            // box-only — see RunSummary in Timeline.tsx (RCTText swallows
            // mouse-down on macOS).
            pointerEvents="box-only"
            style={({ pressed }) => [s.row, selected && s.rowOn, pressed && s.pressed]}
          >
            <ThemeSwatches theme={t} ground={ground} />
            <View style={s.labels}>
              <Text style={selected ? s.nameOn : s.name}>{t.label}</Text>
              <Text style={s.blurb} numberOfLines={1}>
                {t.blurb}
              </Text>
            </View>
            {selected ? (
              <PounceIcon name="checkmark-circle" size={17} color={theme.colors.accent} />
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

const s = StyleSheet.create((theme) => ({
  list: { gap: 8 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  rowOn: { borderColor: theme.colors.accent, backgroundColor: theme.colors.accentSoft },
  pressed: { opacity: 0.8 },
  swatches: { flexDirection: "row", alignItems: "center" },
  swatch: { borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.borderStrong },
  labels: { flex: 1, gap: 2 },
  name: { fontSize: 14, color: theme.colors.fg },
  nameOn: { fontSize: 14, fontWeight: "600", color: theme.colors.accent },
  blurb: { fontSize: 12, color: theme.colors.fgFaint },
}));
