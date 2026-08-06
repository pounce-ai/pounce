import { useEffect } from "react";
import { useColorScheme, View } from "react-native";
import Svg, { Defs, G, LinearGradient, Mask, Rect, Stop, Text as SvgText } from "react-native-svg";
import Animated, {
  Easing,
  useAnimatedProps,
  useSharedValue,
  withRepeat,
  withTiming,
} from "./animation";
import { hexFor } from "../ui/theme-hex";

/**
 * A line of text with a highlight band sweeping across the glyphs — the
 * "thinking" treatment AI clients use in place of a spinner.
 *
 * Built on react-native-svg, which we already ship on every platform, rather
 * than Skia: a Skia canvas would be the natural renderer for this, but it's a
 * new native module, and native modules can't ship over the air. This one is
 * pure JS over a library already in the binary, so it reaches phones in an
 * update instead of waiting on a store review.
 *
 * The sweep is a masked rectangle, not an animated gradient: the mask is the
 * text itself, and the only thing that actually moves is the rect's `x`. That
 * keeps the animated value a plain number, which is the case Reanimated and
 * react-native-svg handle most reliably together.
 *
 * Desktop renders the same thing minus the motion — Reanimated is a static
 * shim there (see animation.desktop.tsx), so the band settles mid-sweep and
 * simply reads as a highlighted label.
 */

/** `animatedProps` is Reanimated's channel, not one of Rect's own props, so the
 *  wrapped component has to declare it. Desktop's shim returns the plain Rect
 *  and folds the values in as static props (see animation.desktop.tsx). */
const AnimatedRect = Animated.createAnimatedComponent(Rect) as unknown as React.ComponentType<
  React.ComponentProps<typeof Rect> & { animatedProps?: unknown }
>;

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
  const scheme = useColorScheme();
  const hex = hexFor(scheme);
  const height = Math.ceil(fontSize * 1.6);
  // The band is a good fraction of the width so the highlight reads as a soft
  // sweep rather than a hard glint, and it starts and ends fully off-canvas so
  // there's no pop at the wrap point.
  const band = Math.max(90, width * 0.45);
  const textX = align === "center" ? width / 2 : 0;
  const anchor = align === "center" ? "middle" : "start";
  const from = -band;
  const to = width;

  const x = useSharedValue(from);
  useEffect(() => {
    x.value = from;
    x.value = withRepeat(withTiming(to, { duration: periodMs, easing: Easing.linear }), -1, false);
  }, [x, from, to, periodMs]);
  const animatedProps = useAnimatedProps(() => ({ x: x.value }));

  return (
    <View accessibilityRole="progressbar" accessibilityLabel={text}>
      <Svg width={width} height={height}>
        <Defs>
          {/* Transparent → bright → transparent, so the leading and trailing
              edges of the band fade instead of cutting. */}
          <LinearGradient id="shimmerBand" x1="0" y1="0" x2="1" y2="0">
            <Stop offset="0" stopColor={hex.fg} stopOpacity="0" />
            <Stop offset="0.5" stopColor={hex.fg} stopOpacity="1" />
            <Stop offset="1" stopColor={hex.fg} stopOpacity="0" />
          </LinearGradient>
          <Mask id="shimmerMask">
            {/* White = visible through the mask, so the band only ever paints
                inside the glyphs. */}
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

        {/* The resting text. The sweep rides on top of this. */}
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
          <AnimatedRect
            animatedProps={animatedProps}
            y={0}
            width={band}
            height={height}
            fill="url(#shimmerBand)"
          />
        </G>
      </Svg>
    </View>
  );
}
