/**
 * Draws whatever `openSheet` parked — the Android half of `pickSheet`.
 *
 * Mounted once by Providers so any callback in the app can reach it without
 * threading a ref. Uses the ordinary NativeSheet, which on Android is a real
 * BottomSheetDialog (react-native-true-sheet), so these menus look like every
 * other sheet in the app rather than a hand-drawn modal.
 *
 * See ui/sheet.ts for why this exists at all.
 */
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useSelector } from "@legendapp/state/react";
import { sheetView$, takePick } from "../ui/sheet";
import { NativeSheet } from "./NativeSheet";

export function SheetHost() {
  const view = useSelector(() => sheetView$.get());
  return (
    // `takePick(-1)` on dismissal rather than nothing at all: every call site
    // already guards its index (`if (i === 0)`), so an out-of-range value is the
    // one answer they all ignore correctly. takePick is idempotent, which
    // matters here — Android fires its dismissal callback after a row press has
    // already closed the sheet.
    <NativeSheet visible={view != null} onClose={() => takePick(-1)}>
      <View>
        {view?.title ? (
          <Text numberOfLines={2} style={s.title}>
            {view.title}
          </Text>
        ) : null}
        {view?.labels.map((label, i) => (
          <Pressable
            key={`${i}:${label}`}
            onPress={() => takePick(i)}
            accessibilityRole="button"
            style={({ pressed }) => [s.row, i > 0 && s.divided, pressed && s.pressed]}
          >
            <Text style={s.label}>{label}</Text>
          </Pressable>
        ))}
        {/* No "Cancel" row: an Android bottom sheet is dismissed by dragging it
            down or pressing back, and ActionSheetIOS's cancel button is an iOS
            convention that would read as a second, redundant control here. */}
      </View>
    </NativeSheet>
  );
}

const s = StyleSheet.create((theme) => ({
  title: { fontSize: 13, color: theme.colors.fgMuted, paddingHorizontal: 4, paddingBottom: 10 },
  row: { minHeight: 52, justifyContent: "center", paddingHorizontal: 4 },
  divided: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
  },
  pressed: { opacity: 0.6 },
  label: { fontSize: 16, color: theme.colors.fg },
}));
