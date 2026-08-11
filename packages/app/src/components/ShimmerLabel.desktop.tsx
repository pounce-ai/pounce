/**
 * Shimmer label — desktop implementation.
 *
 * Identical picture to ./ShimmerLabel, driven by a different clock. The shared
 * one animates through the Reanimated seam, and that seam is a static shim on
 * rn-macos (Reanimated 4 needs the New Architecture, which isn't on here) — so
 * on desktop the band settled mid-sweep and the label just sat there looking
 * highlighted. A "Working" indicator that doesn't move is worse than no
 * indicator: it reads as something stuck.
 *
 * Core `Animated` is the JS-driven API that predates all that and does run
 * here. `useNativeDriver` is false of necessity — the animated value is an SVG
 * `x` attribute, which the native driver can't touch on any platform — but one
 * interpolated number per frame is a cost this can carry, and it only exists
 * while something is actually loading or running.
 */
import { useEffect, useRef } from "react";
import { Animated, Easing, View } from "react-native";
import Svg, { Defs, G, LinearGradient, Mask, Rect, Stop, Text as SvgText } from "react-native-svg";
import { useThemeHex } from "../ui/useThemeHex";

const AnimatedRect = Animated.createAnimatedComponent(Rect);

export function ShimmerLabel({
  text,
  fontSize = 15,
  width = 260,
  /** One full left-to-right pass, in ms. */
  periodMs = 1600,
  align = "left",
}: {
  text: string;
  fontSize?: number;
  width?: number;
  periodMs?: number;
  align?: "left" | "center";
}) {
  const hex = useThemeHex();
  const height = Math.ceil(fontSize * 1.6);
  const band = Math.max(90, width * 0.45);
  const textX = align === "center" ? width / 2 : 0;
  const anchor = align === "center" ? "middle" : "start";
  const from = -band;
  const to = width;

  const t = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(t, {
        toValue: 1,
        duration: periodMs,
        easing: Easing.linear,
        useNativeDriver: false,
      }),
    );
    loop.start();
    // Stopped on unmount, not merely left to garbage: an Animated.loop keeps
    // ticking after its component is gone and would burn a frame timer for the
    // life of the app once a few turns had come and gone.
    return () => loop.stop();
  }, [t, periodMs]);

  const x = t.interpolate({ inputRange: [0, 1], outputRange: [from, to] });

  return (
    <View accessibilityRole="progressbar" accessibilityLabel={text}>
      <Svg width={width} height={height}>
        <Defs>
          <LinearGradient id="shimmerBand" x1="0" y1="0" x2="1" y2="0">
            <Stop offset="0" stopColor={hex.fg} stopOpacity="0" />
            <Stop offset="0.5" stopColor={hex.fg} stopOpacity="1" />
            <Stop offset="1" stopColor={hex.fg} stopOpacity="0" />
          </LinearGradient>
          <Mask id="shimmerMask">
            <SvgText
              x={textX}
              y={height / 2}
              fill="#fff"
              fontSize={fontSize}
              fontWeight="500"
              textAnchor={anchor}
              alignmentBaseline="middle"
            >
              {text}
            </SvgText>
          </Mask>
        </Defs>

        <SvgText
          x={textX}
          y={height / 2}
          fill={hex.fgMuted}
          fontSize={fontSize}
          fontWeight="500"
          textAnchor={anchor}
          alignmentBaseline="middle"
        >
          {text}
        </SvgText>

        <G mask="url(#shimmerMask)">
          <AnimatedRect x={x} y={0} width={band} height={height} fill="url(#shimmerBand)" />
        </G>
      </Svg>
    </View>
  );
}
