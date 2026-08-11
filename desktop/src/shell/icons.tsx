/**
 * Chrome glyphs the icon set doesn't have.
 *
 * Ionicons ships nothing that reads as "sidebar" — the nearest candidates are a
 * browser window, a chevron, or a hamburger, and all three name a different
 * thing. macOS has `sidebar.left` as an SF Symbol, but this file is rendered by
 * react-native-macos through @expo/vector-icons rather than the SF pipeline, so
 * it isn't reachable here either.
 *
 * Two Views draw it exactly: a rounded frame with the leading third filled.
 * That's the shape every editor uses for this control, and it costs less than
 * an SVG would.
 */
import { View, type ColorValue } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useColors } from "@pounce/app/ui/tokens";

export function SidebarGlyph({
  color,
  size = 15,
  /** Fills the panel when the sidebar is open, so the button shows STATE and
   *  not just the action. An outline alone reads the same either way. */
  filled = true,
}: {
  color: ColorValue;
  size?: number;
  filled?: boolean;
}) {
  const h = Math.round(size * 0.8);
  return (
    <View
      style={{
        width: size,
        height: h,
        borderRadius: 3,
        borderWidth: 1.3,
        borderColor: color,
        overflow: "hidden",
      }}
    >
      <View
        style={{
          width: Math.round(size * 0.33),
          height: "100%",
          // The divider is the frame's own edge, so the panel reads as part of
          // the window rather than as a floating block inside it.
          borderRightWidth: 1.3,
          borderRightColor: color,
          backgroundColor: filled ? color : "transparent",
          opacity: filled ? 0.5 : 1,
        }}
      />
    </View>
  );
}

/**
 * A checkbox tick, for the multi-select rows in Peers and Access.
 *
 * Both screens had drawn their own — same two Views, same accent-fill-when-on,
 * differing only in a point of size. `size` keeps that difference without
 * keeping two components.
 */
export function CheckGlyph({ on, size = 16 }: { on: boolean; size?: number }) {
  const COLOR = useColors();
  return (
    <View
      style={{
        height: size,
        width: size,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: Math.round(size / 3.5),
        borderWidth: 1,
        borderColor: on ? COLOR.accent : COLOR.border,
        backgroundColor: on ? COLOR.accent : "transparent",
      }}
    >
      {on ? <Ionicons name="checkmark" size={Math.round(size * 0.78)} color={COLOR.bg} /> : null}
    </View>
  );
}
