import { useColorScheme, View } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { hexFor } from "../ui/theme-hex";

/**
 * A short fade from transparent into the page background, sitting on the top
 * edge of the composer bar.
 *
 * The transcript runs the full height of the screen with the composer floating
 * over it (that's what lets the list own the keyboard inset), so scrolling
 * content passes underneath it. Against an opaque bar that reads as a line of
 * text sliced in half — the message looks broken rather than continued. Fading
 * the last few points instead makes it read as content passing under the
 * composer, which is what every chat client does here.
 *
 * Mobile only: on desktop the composer sits in normal flow and the list simply
 * ends above it, so nothing ever passes under and there is nothing to fade.
 */

export const SCRIM_HEIGHT = 28;

export function ComposerScrim() {
  const bg = hexFor(useColorScheme()).bg;
  return (
    // In NORMAL FLOW, deliberately: it has to be part of what the composer
    // wrapper measures. Floated above the bar it covered SCRIM_HEIGHT of
    // transcript that the list's content inset believed was clear, so the fade
    // landed on content that should have been fully readable — the scrim itself
    // became the clipping it was added to cure.
    <View pointerEvents="none" style={{ height: SCRIM_HEIGHT }}>
      <Svg width="100%" height={SCRIM_HEIGHT}>
        <Defs>
          <LinearGradient id="composerScrim" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={bg} stopOpacity="0" />
            <Stop offset="1" stopColor={bg} stopOpacity="1" />
          </LinearGradient>
        </Defs>
        <Rect width="100%" height={SCRIM_HEIGHT} fill="url(#composerScrim)" />
      </Svg>
    </View>
  );
}
