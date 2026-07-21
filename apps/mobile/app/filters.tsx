import { ScrollView } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { router } from "expo-router";
import { FilterSheetContent } from "@pounce/app/components/FilterSheet";

/** Filters as a TrueSheet screen (see the Sheet.Screen options in _layout).
 *  No flex:1 on the root: the sheet's 'auto' detent measures intrinsic
 *  content height, and a flexed ScrollView would measure as zero. */
export default function FiltersSheet() {
  return (
    <ScrollView
      style={s.root}
      contentContainerStyle={{ gap: 16, paddingBottom: 32 }}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
    >
      <FilterSheetContent onClose={() => router.back()} />
    </ScrollView>
  );
}

const s = StyleSheet.create((theme) => ({
  root: { backgroundColor: theme.colors.bgElevated, paddingHorizontal: 16, paddingTop: 12 },
}));
