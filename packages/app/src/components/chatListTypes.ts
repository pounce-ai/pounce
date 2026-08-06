/**
 * Shared contract for the chat-list seam (ChatList.tsx / ChatList.mobile.tsx).
 *
 * Both implementations import these types so the two stay in step even though
 * only one is ever bundled: mobile resolves ChatList.ios/.android → the
 * keyboard-aware list, macOS/Windows fall back to the plain ChatList.tsx.
 */
import type { LayoutChangeEvent } from "react-native";
import type { LegendListProps, LegendListRef } from "@legendapp/list/react-native";

/**
 * ChatGPT-style send anchor: reserve trailing space so the anchored message
 * sits `anchorOffset` from the top of the viewport and the reply streams into
 * the space below it, instead of the whole thread crawling upward token by
 * token. LegendList shrinks the reserved space as the reply grows and reports
 * the remaining size through `onSizeChanged` (0 = the reply has outgrown it).
 */
export interface ChatAnchor {
  anchorIndex: number;
  anchorOffset?: number;
  anchorMaxSize?: number;
  onSizeChanged?: (size: number) => void;
}

/**
 * Opaque bag of keyboard-driven list props produced by `useChatKeyboard` and
 * spread onto `<ChatList>`. Its contents are platform-private (SharedValues on
 * mobile, nothing on desktop), so callers only ever pass it through.
 */
export type ChatKeyboardProps = Record<string, unknown> | undefined;

export interface ChatKeyboardHandle {
  /** Spread onto `<ChatList>`. */
  keyboard: ChatKeyboardProps;
  /** Wire to the composer wrapper's `onLayout` so the list can inset for it. */
  onComposerLayout: (event: LayoutChangeEvent) => void;
  /** Scroll the conversation to the end, coordinated with the keyboard. */
  scrollMessageToEnd: (options?: { animated?: boolean; closeKeyboard?: boolean }) => void;
  /** Composer height in px — positions the floating "Latest" pill above it. */
  composerHeight: number;
}

export type ChatListProps<ItemT> = Omit<
  LegendListProps<ItemT>,
  "maintainVisibleContentPosition"
> & {
  /** Fires with `false` the moment the bottom of the conversation scrolls out
   *  of view, and `true` when it comes back. Native on mobile (the keyboard-aware
   *  scroll view computes it); synthesized from `onScroll` on desktop. */
  onEndVisible?: (visible: boolean) => void;
  anchoredEndSpace?: ChatAnchor;
  keyboard?: ChatKeyboardProps;
  maintainVisibleContentPosition?: LegendListProps<ItemT>["maintainVisibleContentPosition"];
  /** Declared explicitly: React 19 passes `ref` as a plain prop to function
   *  components, but it still has to appear in the props type to be accepted. */
  ref?: React.Ref<LegendListRef>;
};

export type ChatListRef = LegendListRef;

/** Distance from the bottom (px) still counted as "at the end" on desktop. */
export const AT_END_PX = 80;
