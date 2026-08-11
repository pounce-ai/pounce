/**
 * The week/month/year selector that heads every analytics surface.
 *
 * One component in three platform variants, because a segmented control is a
 * NATIVE control on both phones and there is no reason to draw our own: iOS has
 * a SwiftUI Picker in its segmented style, Android has Material 3's
 * SingleChoiceSegmentedButtonRow, and both come with the platform's own
 * sizing, press states, animation and accessibility. The hand-rolled row this
 * replaces was three copies of the same Pressable pair in three screens.
 *
 * Desktop keeps that hand-rolled row (PeriodPicker.tsx) — @expo/ui has no
 * macOS/Windows binding, and the shell's chrome is its own idiom anyway.
 */
import type { Period } from "../services/activity";

export interface PeriodPickerProps {
  value: Period;
  onChange: (p: Period) => void;
  /** The order they appear in, left to right. */
  periods: readonly Period[];
}
