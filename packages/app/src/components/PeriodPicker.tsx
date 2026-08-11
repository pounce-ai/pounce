/**
 * Desktop (macOS/Windows): the hand-drawn segmented row.
 *
 * @expo/ui binds SwiftUI and Jetpack Compose — there is no macOS or Windows
 * renderer behind it, so the phones' native control isn't an option here. This
 * is the same row the three analytics screens each used to carry their own copy
 * of; keeping ONE copy is most of the point of extracting the component.
 *
 * See ./PeriodPickerTypes.ts for the platform split.
 */
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { PERIOD_LABEL } from "../services/activity";
import type { PeriodPickerProps } from "./PeriodPickerTypes";

export function PeriodPicker({ value, onChange, periods }: PeriodPickerProps) {
  return (
    <View style={s.segment}>
      {periods.map((p) => (
        <Pressable
          key={p}
          onPress={() => onChange(p)}
          style={[s.item, p === value && s.itemOn]}
          accessibilityRole="button"
          accessibilityState={{ selected: p === value }}
        >
          <Text style={[s.label, p === value && s.labelOn]}>{PERIOD_LABEL[p]}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const s = StyleSheet.create((theme) => ({
  segment: {
    alignSelf: "flex-start",
    flexDirection: "row",
    gap: 2,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: 2,
  },
  item: { minWidth: 68, alignItems: "center", borderRadius: 7, paddingVertical: 5 },
  itemOn: { backgroundColor: theme.colors.accent },
  label: { fontSize: 12.5, fontWeight: "600", color: theme.colors.fgMuted },
  labelOn: { color: theme.colors.onAccent },
}));
