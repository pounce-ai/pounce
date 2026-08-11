import type { ComponentProps } from "react";
import type { Ionicons } from "@expo/vector-icons";
import type { SFSymbol } from "sf-symbols-typescript";

export type IoniconName = ComponentProps<typeof Ionicons>["name"];

/** Shared props for PounceIcon across the platform variants. */
export interface PounceIconProps {
  name: IoniconName;
  size?: number;
  color?: import("react-native").ColorValue;
  style?: ComponentProps<typeof Ionicons>["style"];
  /**
   * An SF Symbol animation (a pulse, a variable-colour sweep). iOS ONLY, and
   * silently ignored elsewhere: no other platform here has animating glyphs, so
   * a caller that wants motion everywhere has to draw its own — see
   * components/WorkingDots.tsx, which does exactly that.
   */
  symbolAnimation?: SymbolAnimation;
}

/** Mirrors expo-symbols' AnimationSpec, minus the parts we don't use. Declared
 *  here rather than imported so the non-iOS variants — which must never load
 *  expo-symbols, an iOS-only native module — can still type this prop. */
export interface SymbolAnimation {
  repeating?: boolean;
  repeatCount?: number;
  speed?: number;
  effect?: { type: "bounce" | "pulse" | "scale"; wholeSymbol?: boolean };
  variableAnimationSpec?: {
    reversing?: boolean;
    nonReversing?: boolean;
    cumulative?: boolean;
    iterative?: boolean;
    dimInactiveLayers?: boolean;
  };
}

/** Ionicons vocabulary → SF Symbols. The Ionicons name stays the canonical
 *  cross-platform API (Android/desktop render it directly); iOS looks up the
 *  SF Symbol here and falls back to the Ionicon when a name is missing. */
export const SF_SYMBOL: Partial<Record<IoniconName, SFSymbol>> = {
  add: "plus",
  "add-circle": "plus.circle.fill",
  "alert-circle": "exclamationmark.circle.fill",
  "arrow-down": "arrow.down",
  "arrow-up": "arrow.up",
  attach: "paperclip",
  "book-outline": "book",
  bookmark: "bookmark.fill",
  "bookmark-outline": "bookmark",
  "card-outline": "creditcard",
  "chatbubbles-outline": "bubble.left.and.bubble.right",
  checkbox: "checkmark.square.fill",
  checkmark: "checkmark",
  "checkmark-circle": "checkmark.circle.fill",
  "checkmark-circle-outline": "checkmark.circle",
  "chevron-back": "chevron.left",
  "chevron-down": "chevron.down",
  "chatbubble-ellipses-outline": "bubble.left",
  "code-slash-outline": "chevron.left.forwardslash.chevron.right",
  "color-palette-outline": "paintbrush",
  "construct-outline": "wrench.and.screwdriver",
  "globe-outline": "globe",
  "list-outline": "list.bullet",
  "chevron-forward": "chevron.right",
  "chevron-up": "chevron.up",
  close: "xmark",
  "close-circle": "xmark.circle.fill",
  "close-circle-outline": "xmark.circle",
  contrast: "circle.lefthalf.filled",
  "cloud-offline-outline": "icloud.slash",
  "cloud-upload-outline": "icloud.and.arrow.up",
  "copy-outline": "doc.on.doc",
  "create-outline": "square.and.pencil",
  "desktop-outline": "desktopcomputer",
  "document-outline": "doc",
  "document-text-outline": "doc.text",
  "ellipse-outline": "circle",
  "ellipsis-horizontal": "ellipsis",
  filter: "line.3.horizontal.decrease",
  flash: "bolt.fill",
  "flash-outline": "bolt",
  "folder-outline": "folder",
  "folder-open-outline": "folder.fill",
  "git-branch-outline": "arrow.branch",
  "git-commit-outline": "smallcircle.filled.circle",
  "git-compare-outline": "arrow.left.arrow.right",
  "git-network-outline": "point.3.connected.trianglepath.dotted",
  "git-pull-request-outline": "arrow.triangle.merge",
  "help-circle-outline": "questionmark.circle",
  "image-outline": "photo",
  "key-outline": "key",
  "laptop-outline": "laptopcomputer",
  "link-outline": "link",
  "lock-closed": "lock.fill",
  "map-outline": "map",
  "medkit-outline": "cross.case",
  mic: "mic.fill",
  "mic-outline": "mic",
  moon: "moon.fill",
  "pencil-outline": "pencil",
  "person-circle-outline": "person.crop.circle",
  "phone-portrait-outline": "iphone",
  play: "play.fill",
  "qr-code-outline": "qrcode",
  "radio-button-off": "circle",
  "radio-button-on": "circle.inset.filled",
  refresh: "arrow.clockwise",
  search: "magnifyingglass",
  "server-outline": "server.rack",
  "share-outline": "square.and.arrow.up",
  "shield-checkmark-outline": "checkmark.shield",
  "stats-chart-outline": "chart.bar",
  "eye-off": "eye.slash",
  "eye-outline": "eye",
  sparkles: "sparkles",
  "square-outline": "square",
  star: "star.fill",
  stop: "stop.fill",
  "stop-circle-outline": "stop.circle",
  sunny: "sun.max.fill",
  sync: "arrow.triangle.2.circlepath",
  "terminal-outline": "apple.terminal",
  "time-outline": "clock",
  "trash-outline": "trash",
};
