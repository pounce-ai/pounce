/**
 * Animation seam — desktop implementation.
 *
 * Reanimated 4 needs the New Architecture (not enabled on rn-macos/windows
 * here), so desktop renders the final state of every animation statically:
 * shared values hold plain numbers, `with*` helpers resolve to their target
 * value, entering/exiting props are stripped, and layout transitions are
 * no-ops. Motion is a progressive enhancement — the UI is identical, just
 * without the tween.
 */
import { useMemo, useRef } from "react";
import {
  ScrollView as RNScrollView,
  Text as RNText,
  View as RNView,
  type ViewProps,
} from "react-native";

type AnyProps = Record<string, unknown>;

/** Strip Reanimated-only props so they never reach the native view. */
function clean<P extends AnyProps>(props: P): P {
  const { entering, exiting, layout, ...rest } = props;
  void entering;
  void exiting;
  void layout;
  return rest as P;
}

function AnimatedView(props: ViewProps & AnyProps) {
  return <RNView {...clean(props)} />;
}
function AnimatedText(props: AnyProps) {
  return <RNText {...clean(props)} />;
}
function AnimatedScrollView(props: AnyProps) {
  return <RNScrollView {...clean(props)} />;
}

const Animated = {
  View: AnimatedView,
  Text: AnimatedText,
  ScrollView: AnimatedScrollView,
  /** Reanimated feeds values through `animatedProps`; there is no animation
   *  here, so fold them in as ordinary props and strip the channel itself —
   *  otherwise it leaks to the native view as an unknown prop. */
  createAnimatedComponent: <T,>(component: T): T => {
    const Inner = component as unknown as React.ComponentType<AnyProps>;
    const Wrapped = (props: AnyProps) => {
      const { animatedProps, ...rest } = clean(props);
      return <Inner {...rest} {...((animatedProps as AnyProps) ?? {})} />;
    };
    return Wrapped as unknown as T;
  },
};
export default Animated;
export { Animated };

export interface SharedValue<T> {
  value: T;
}

export function useSharedValue<T>(initial: T): SharedValue<T> {
  return useRef({ value: initial }).current;
}

/** Evaluate once per render — values are static on this platform. */
export function useAnimatedStyle<T extends object>(factory: () => T): T {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(factory, []);
}

/** Same deal for animated props: one static evaluation, spread as plain props. */
export function useAnimatedProps<T extends object>(factory: () => T): T {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(factory, []);
}

// `with*` helpers resolve straight to their settled value.
export function withTiming<T>(toValue: T, _config?: unknown, _cb?: unknown): T {
  return toValue;
}
export function withDelay<T>(_ms: number, value: T): T {
  return value;
}
export function withSequence<T>(...values: T[]): T {
  return values[values.length - 1] as T;
}
export function withRepeat<T>(value: T, _times?: number, _reverse?: boolean): T {
  return value;
}
export function cancelAnimation(_sv: SharedValue<unknown>): void {}

/** Chainable no-op entering/exiting/layout builders (FadeIn.duration(…), …). */
interface NoopAnimation {
  duration: (ms: number) => NoopAnimation;
  delay: (ms: number) => NoopAnimation;
  springify: () => NoopAnimation;
  damping: (n: number) => NoopAnimation;
  easing: (e: unknown) => NoopAnimation;
}
function noopAnimation(): NoopAnimation {
  const chain: NoopAnimation = {
    duration: () => chain,
    delay: () => chain,
    springify: () => chain,
    damping: () => chain,
    easing: () => chain,
  };
  return chain;
}
export const FadeIn = noopAnimation();
export const FadeOut = noopAnimation();
export const LinearTransition = noopAnimation();
export const SlideInDown = noopAnimation();
export const ZoomIn = noopAnimation();
export const ZoomOut = noopAnimation();

/** Easing stand-in: the chainable builders above ignore whatever it returns,
 *  so these only have to exist and be callable. */
export const Easing = {
  exp: (t: number) => t,
  linear: (t: number) => t,
  ease: (t: number) => t,
  out: (fn: unknown) => fn,
  in: (fn: unknown) => fn,
  inOut: (fn: unknown) => fn,
};
