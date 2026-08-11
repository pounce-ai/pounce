/**
 * iOS: a real UISegmentedControl, via SwiftUI's Picker in its segmented style.
 *
 * `Host` is required around any @expo/ui tree, and `matchContents` lets it size
 * to the control rather than claiming a fixed box. The height is spelled out
 * because a segmented Picker reports no intrinsic height through the host on
 * its own, and a zero-height row is invisible.
 *
 * See ./PeriodPickerTypes.ts for why this is native at all.
 */
import { Host } from "@expo/ui";
import { Picker } from "@expo/ui/swift-ui";
import { Text } from "@expo/ui/swift-ui";
import { pickerStyle, tag } from "@expo/ui/swift-ui/modifiers";
import { StyleSheet } from "react-native-unistyles";
import { PERIOD_LABEL } from "../services/activity";
import type { Period } from "../services/activity";
import type { PeriodPickerProps } from "./PeriodPickerTypes";

export function PeriodPicker({ value, onChange, periods }: PeriodPickerProps) {
  return (
    // NOT `matchContents`: that sizes the host to the control, which leaves a
    // segmented control hugging its three labels and floating short of the
    // cards below it. Letting the host take the width makes every period the
    // same size and lines the control up with the content it filters.
    <Host style={s.host}>
      <Picker
        selection={value}
        onSelectionChange={(p) => onChange(p as Period)}
        modifiers={[pickerStyle("segmented")]}
      >
        {periods.map((p) => (
          <Text key={p} modifiers={[tag(p)]}>
            {PERIOD_LABEL[p]}
          </Text>
        ))}
      </Picker>
    </Host>
  );
}

const s = StyleSheet.create({
  /** `alignSelf: stretch` is what actually makes it full width — the host
   *  otherwise sizes to its content, whatever the parent's alignment. */
  host: { height: 32, alignSelf: "stretch" },
});
