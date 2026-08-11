/**
 * Android: Material 3's own segmented control.
 *
 * `SingleChoiceSegmentedButtonRow` is the Compose component this control IS —
 * selection shape, ripple, check glyph and all — so the row is declared rather
 * than drawn. `Host` is required around any @expo/ui tree; the height is
 * spelled out because the row reports no intrinsic height through the host.
 *
 * See ./PeriodPickerTypes.ts for why this is native at all.
 */
import { Host } from "@expo/ui";
import { SegmentedButton, SingleChoiceSegmentedButtonRow, Text } from "@expo/ui/jetpack-compose";
import { StyleSheet } from "react-native-unistyles";
import { PERIOD_LABEL } from "../services/activity";
import type { PeriodPickerProps } from "./PeriodPickerTypes";

export function PeriodPicker({ value, onChange, periods }: PeriodPickerProps) {
  return (
    <Host style={s.host}>
      <SingleChoiceSegmentedButtonRow>
        {periods.map((p) => (
          <SegmentedButton key={p} selected={p === value} onClick={() => onChange(p)}>
            {/* The label is a SLOT, not a prop, and Compose composes a real
                Text into it — a bare string throws "Text strings must be
                rendered within a <Text> component". */}
            <SegmentedButton.Label>
              <Text>{PERIOD_LABEL[p]}</Text>
            </SegmentedButton.Label>
          </SegmentedButton>
        ))}
      </SingleChoiceSegmentedButtonRow>
    </Host>
  );
}

const s = StyleSheet.create({
  /** `alignSelf: stretch` is what actually makes it full width — the host
   *  otherwise sizes to its content, whatever the parent's alignment. */
  host: { height: 44, alignSelf: "stretch" },
});
