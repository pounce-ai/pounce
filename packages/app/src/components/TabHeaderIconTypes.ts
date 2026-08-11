/**
 * A tab's glyph, named the way each platform names it.
 *
 * The SAME shape `NativeTabs.Trigger.Icon` takes — `sf` for iOS, `md` for
 * Android — so a tab declares its icon once in the tab bar and once in its
 * header using identical vocabulary, and the two can be checked against each
 * other by eye.
 *
 * Deliberately NOT an Ionicon name run through icon-map: that indirection
 * exists so one name can serve both platforms, which is the wrong trade here.
 * These four glyphs already have exact SF Symbol and Material Symbol
 * counterparts, and the tab bar is already written in those terms.
 */
import type { SFSymbol } from "sf-symbols-typescript";
import type { ComponentProps } from "react";
import type { MaterialIcons } from "@expo/vector-icons";

export interface TabHeaderIconProps {
  /** iOS — an SF Symbol, rendered by expo-symbols. */
  sf: SFSymbol;
  /** Android — a Material icon, from the font @expo/vector-icons already ships. */
  md: ComponentProps<typeof MaterialIcons>["name"];
  /** Swap the glyph for a spinner while a sync runs (Home's connection state). */
  busy?: boolean;
}
