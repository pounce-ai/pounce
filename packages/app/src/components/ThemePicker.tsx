/**
 * Theme picker — one row per theme, each showing the palette it will paint
 * (page, card, accent, text) so the choice is made by looking rather than by
 * reading a name. Shared by the mobile Settings screen and the desktop shell.
 *
 * The swatches are drawn in the CURRENT ground: previewing "Ember" while the
 * app is forced light should show Ember's light palette, not its dark one.
 */
import { Pressable, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useSelector } from "@legendapp/state/react";
import { setTheme, theme$ } from "../state/appearance";
import { PounceIcon } from "../ui/native/Icon";
import { THEMES, previewSwatches, themeById } from "../ui/palettes";
import { useGround } from "../ui/useThemeHex";

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
            // box-only, or this row is dead on react-native-macos: RCTText (and
            // an Ionicon, which is a text glyph too) takes the mouse-down for
            // selection and the Pressable never fires. The row has no content
            // worth selecting, so swallowing all of it at the box is right.
            pointerEvents="box-only"
            style={({ pressed }) => [s.row, selected && s.rowOn, pressed && s.pressed]}
          >
            <View style={s.swatches}>
              {previewSwatches(t, ground).map((color, i) => (
                <View
                  key={i}
                  style={[s.swatch, i > 0 && s.swatchOverlap, { backgroundColor: color }]}
                />
              ))}
            </View>
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
  swatch: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderStrong,
  },
  /** Overlapped so four colours read as one palette chip, not a row of dots. */
  swatchOverlap: { marginLeft: -7 },
  labels: { flex: 1, gap: 2 },
  name: { fontSize: 14, color: theme.colors.fg },
  nameOn: { fontSize: 14, fontWeight: "600", color: theme.colors.accent },
  blurb: { fontSize: 12, color: theme.colors.fgFaint },
}));
