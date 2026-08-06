/**
 * Chat-list seam — default (desktop) implementation.
 *
 * macOS/Windows have no software keyboard, and Providers.desktop deliberately
 * omits react-native-keyboard-controller's KeyboardProvider, so this variant
 * renders the plain LegendList and stubs the keyboard wiring out. The anchored
 * send space still works here — it's a LegendList feature, not a keyboard one —
 * so desktop gets the same "your message jumps to the top" behaviour.
 *
 * iOS/Android resolve ChatList.ios/.android → ChatList.mobile.
 */
import { useCallback, useRef, useState } from "react";
import {
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ViewProps,
} from "react-native";
import { LegendList } from "@legendapp/list/react-native";
import {
  AT_END_PX,
  type ChatKeyboardHandle,
  type ChatListProps,
  type ChatListRef,
} from "./chatListTypes";

/** Seeded non-zero on purpose. Consumers use this to clear the composer
 *  (the loading label's bottom padding, the Latest pill's offset), and a 0 on
 *  the first frames parks them underneath it — which is exactly what made the
 *  "Loading conversation…" line appear clipped before onLayout landed.
 *  Overestimating is safe: things settle downward once measured. */
export const INITIAL_COMPOSER_HEIGHT = 132;

export function ChatList<ItemT>({
  onEndVisible,
  keyboard,
  onScroll,
  ...rest
}: ChatListProps<ItemT>) {
  void keyboard;
  // No keyboard-aware scroll view here, so `onEndVisible` is derived from the
  // scroll position. Edge-triggered: only report when the answer changes, so
  // consumers don't re-render on every frame of a drag.
  const atEnd = useRef<boolean | null>(null);
  const handleScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
      const visible = contentSize.height - (contentOffset.y + layoutMeasurement.height) < AT_END_PX;
      if (atEnd.current !== visible) {
        atEnd.current = visible;
        onEndVisible?.(visible);
      }
      onScroll?.(e);
    },
    [onEndVisible, onScroll],
  );
  return <LegendList {...rest} onScroll={handleScroll} scrollEventThrottle={64} />;
}

/** Desktop: nothing to avoid. The composer sits in normal flow, so the only
 *  live value is its measured height (for the floating "Latest" pill). */
export function useChatKeyboard(
  listRef: React.RefObject<ChatListRef | null>,
  composerRef: React.RefObject<{ measure: unknown } | null>,
): ChatKeyboardHandle {
  void composerRef;
  const [composerHeight, setComposerHeight] = useState(INITIAL_COMPOSER_HEIGHT);
  const onComposerLayout = useCallback((event: LayoutChangeEvent) => {
    setComposerHeight(event.nativeEvent.layout.height);
  }, []);
  const scrollMessageToEnd = useCallback(
    (options?: { animated?: boolean }) => {
      listRef.current?.scrollToEnd({ animated: options?.animated ?? true });
    },
    [listRef],
  );
  return { keyboard: undefined, onComposerLayout, scrollMessageToEnd, composerHeight };
}

/** Desktop: a plain View — there is no keyboard for it to stick to. */
export function ChatKeyboardSticky({ children, ...rest }: ViewProps) {
  return <View {...rest}>{children}</View>;
}

/** The composer sits in normal flow on desktop, so the transcript needs no
 *  inset for it and the layout below stays exactly as it was. */
export const COMPOSER_OVERLAYS_LIST = false;
