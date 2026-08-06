/**
 * Chat-list seam — mobile implementation (resolved via ChatList.ios/.android).
 *
 * Replaces the KeyboardAvoidingView + flex-layout arrangement with the pattern
 * LegendList and react-native-keyboard-controller are built for:
 *
 *   • KeyboardAwareLegendList tracks the keyboard on the UI thread, so the
 *     transcript lifts in the same frame as the keyboard instead of the JS
 *     thread re-laying-out the whole screen on every keyboard event.
 *   • The composer floats over the list inside a KeyboardStickyView, and
 *     `useKeyboardChatComposerInset` feeds its measured height back as a
 *     content inset — so the last message clears the composer exactly, with no
 *     guessing and no gap between the last message and the keyboard.
 *   • `useKeyboardScrollToEnd` coordinates the send-time scroll with the
 *     keyboard dismissal so the two don't fight.
 *
 * All of this is JS over already-installed native modules (@legendapp/list
 * 3.3.3, react-native-keyboard-controller 1.21.9, reanimated 4.5) — no new
 * native code, so it ships over the air.
 */
import { useCallback, useMemo, useState } from "react";
import type { LayoutChangeEvent } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import {
  KeyboardAwareLegendList,
  useKeyboardChatComposerInset,
  useKeyboardScrollToEnd,
} from "@legendapp/list/keyboard";
import type { ChatKeyboardHandle, ChatListProps, ChatListRef } from "./chatListTypes";

/** Seeded non-zero on purpose. Consumers use this to clear the composer
 *  (the loading label's bottom padding, the Latest pill's offset), and a 0 on
 *  the first frames parks them underneath it — which is exactly what made the
 *  "Loading conversation…" line appear clipped before onLayout landed.
 *  Overestimating is safe: things settle downward once measured. */
export const INITIAL_COMPOSER_HEIGHT = 132;

export function ChatList<ItemT>({ keyboard, ...rest }: ChatListProps<ItemT>) {
  return (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the
    // keyboard bag is intentionally opaque to callers (see ChatKeyboardProps);
    // its shape is agreed between useChatKeyboard and this component alone.
    <KeyboardAwareLegendList
      {...(rest as any)}
      {...(keyboard ?? {})}
      // The keyboard lifts the content only when the user is already reading the
      // newest message; someone scrolled up into history stays where they are.
      keyboardLiftBehavior="whenAtEnd"
      keyboardDismissMode="interactive"
      // RN 0.81+ stops hit-testing the area covered by a bottom contentInset,
      // which would make the anchored end space (and the bottom of the last
      // message) swallow touches. facebook/react-native#54123.
      applyWorkaroundForContentInsetHitTestBug
    />
  );
}

export function useChatKeyboard(
  listRef: React.RefObject<ChatListRef | null>,
  composerRef: React.RefObject<{ measure: unknown } | null>,
): ChatKeyboardHandle {
  const insets = useSafeAreaInsets();
  const [composerHeight, setComposerHeight] = useState(INITIAL_COMPOSER_HEIGHT);
  const { contentInsetEndAdjustment, onComposerLayout: reportComposerInset } =
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the hook wants
    // a ref exposing `measure`; our composer wrapper is a plain View that does.
    // Third arg is the initial height: same reason as the state above — without
    // it the list's bottom inset is 0 until the first layout, so the tail of the
    // transcript renders underneath the composer on the opening frames.
    useKeyboardChatComposerInset(listRef as any, composerRef as any, INITIAL_COMPOSER_HEIGHT);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { freeze, scrollMessageToEnd } = useKeyboardScrollToEnd({ listRef: listRef as any });

  const onComposerLayout = useCallback(
    (event: LayoutChangeEvent) => {
      setComposerHeight(event.nativeEvent.layout.height);
      reportComposerInset(event);
    },
    [reportComposerInset],
  );

  const scroll = useCallback(
    (options?: { animated?: boolean; closeKeyboard?: boolean }) => {
      void scrollMessageToEnd({
        animated: options?.animated ?? true,
        closeKeyboard: options?.closeKeyboard ?? false,
      });
    },
    [scrollMessageToEnd],
  );

  const keyboard = useMemo(
    // `keyboardOffset` must match the composer's own KeyboardStickyView offset,
    // or a gap the size of the home indicator opens between the last message
    // and the keyboard.
    () => ({ contentInsetEndAdjustment, freeze, keyboardOffset: insets.bottom }),
    [contentInsetEndAdjustment, freeze, insets.bottom],
  );

  return { keyboard, onComposerLayout, scrollMessageToEnd: scroll, composerHeight };
}

/** Rides up with the keyboard on the UI thread. `offset.opened` cancels the
 *  bottom safe-area inset, which the keyboard itself covers once open. */
export function ChatKeyboardSticky({
  children,
  ...rest
}: React.ComponentProps<typeof KeyboardStickyView>) {
  const insets = useSafeAreaInsets();
  const offset = useMemo(() => ({ opened: insets.bottom }), [insets.bottom]);
  return (
    <KeyboardStickyView offset={offset} {...rest}>
      {children}
    </KeyboardStickyView>
  );
}

/** The composer floats over the transcript here; the list insets for it via
 *  `contentInsetEndAdjustment` rather than sharing the column in flex flow. */
export const COMPOSER_OVERLAYS_LIST = true;
