/**
 * The Activity screen's bones — the shape, without the animation.
 *
 * Layout lives here so both Skeleton forks render an identical skeleton and
 * only differ in how they pulse it (Reanimated on the phones, core Animated on
 * desktop — see Skeleton.desktop). Each fork wraps this in its own animated
 * opacity.
 *
 * Plain style objects, not a unistyles sheet: these are rendered inside an
 * animated view, and unistyles entries carry a C++ proxy that Reanimated reads
 * as an empty object ("an empty object is not a valid style value"). `T` is a
 * plain token map, so it crosses fine.
 */
import { View } from "react-native";
import { T } from "../ui/theme";
import { IS_DESKTOP } from "../ui";

/** One bone. `w` may be a percentage string or a number of points. */
export function Bone({
  w,
  h,
  r = 6,
  mt = 0,
}: {
  w: number | `${number}%`;
  h: number;
  r?: number;
  mt?: number;
}) {
  return (
    <View
      style={{
        width: w,
        height: h,
        borderRadius: r,
        marginTop: mt,
        backgroundColor: T.surfaceHover,
      }}
    />
  );
}

const card = {
  borderRadius: 12,
  borderWidth: 1,
  borderColor: T.border,
  backgroundColor: T.surfaceAlt,
  padding: 14,
} as const;

/** A metric tile: label, figure, delta. */
function TileBone() {
  return (
    <View style={{ ...card, flex: 1, gap: 6 }}>
      <Bone w="55%" h={9} r={3} />
      <Bone w="70%" h={20} r={5} mt={2} />
      <Bone w="35%" h={9} r={3} />
    </View>
  );
}

/**
 * Bones in the real screen's order — heatmap, two rows of tiles, plan usage,
 * streaks, chart — so the skeleton dissolves into the content rather than
 * rearranging into it.
 */
export function ActivityBones() {
  return (
    <View style={{ gap: 12 }} pointerEvents="none">
      {/* Period picker */}
      <View style={{ flexDirection: "row", gap: 2, alignSelf: "flex-start" }}>
        <Bone w={IS_DESKTOP ? 62 : 104} h={30} r={8} />
        <Bone w={IS_DESKTOP ? 62 : 104} h={30} r={8} />
        <Bone w={IS_DESKTOP ? 62 : 104} h={30} r={8} />
      </View>

      {/* Heatmap card */}
      <View style={{ ...card, gap: 10 }}>
        <Bone w="30%" h={9} r={3} />
        <Bone w="100%" h={IS_DESKTOP ? 96 : 26} r={6} />
        <Bone w="45%" h={9} r={3} />
      </View>

      {/* Two rows of metric tiles */}
      <View style={{ flexDirection: "row", gap: 10 }}>
        <TileBone />
        <TileBone />
      </View>
      <View style={{ flexDirection: "row", gap: 10 }}>
        <TileBone />
        <TileBone />
      </View>

      {/* Plan usage: a heading over per-agent cards */}
      <Bone w="28%" h={9} r={3} mt={2} />
      <View style={{ ...card, gap: 8 }}>
        <Bone w="40%" h={13} r={4} />
        <Bone w="75%" h={9} r={3} />
        <Bone w="100%" h={5} r={999} mt={2} />
      </View>
      <View style={{ ...card, gap: 8 }}>
        <Bone w="35%" h={13} r={4} />
        <Bone w="60%" h={9} r={3} />
      </View>

      {/* Streak row */}
      <View
        style={{
          ...card,
          flexDirection: "row",
          justifyContent: "space-around",
          alignItems: "center",
        }}
      >
        <Bone w={44} h={22} r={5} />
        <Bone w={44} h={22} r={5} />
        <Bone w={44} h={22} r={5} />
      </View>

      {/* Trend chart */}
      <View style={{ ...card, gap: 10 }}>
        <Bone w="42%" h={9} r={3} />
        <Bone w="100%" h={IS_DESKTOP ? 120 : 96} r={6} />
      </View>
    </View>
  );
}
