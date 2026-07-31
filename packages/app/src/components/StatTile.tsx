import { Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { PounceIcon } from "../ui/native/Icon";
import type { IoniconName } from "../ui/native/icon-map";
import { useTweenedNumber } from "../ui/useTweenedNumber";

/**
 * One headline number with its label and optional period-over-period delta —
 * the dashboard's KPI unit. Figures use the mono face so a grid of tiles
 * aligns digit-for-digit.
 */
export function StatTile({
  label,
  value,
  delta,
  hint,
  icon,
  /** True when a bigger number is worse (spend) — flips the delta's coloring. */
  inverse,
  hero,
  numeric,
  format,
}: {
  label: string;
  /** Pre-formatted fallback, and what's shown when there's nothing to tween
   *  (a null cost renders "—", which isn't a number). */
  value: string;
  delta?: string | null;
  hint?: string | null;
  icon?: IoniconName;
  inverse?: boolean;
  hero?: boolean;
  /** Raw figure behind `value`. Supplying it with `format` makes the tile ease
   *  between values instead of cutting, so changing the period reads as the
   *  same number moving. */
  numeric?: number | null;
  format?: (n: number) => string;
}) {
  const { theme } = useUnistyles();
  const up = delta?.startsWith("+");
  const good = inverse ? !up : up;
  const animatable = numeric != null && Number.isFinite(numeric) && !!format;
  const tweened = useTweenedNumber(animatable ? numeric : 0);
  const shown = animatable ? format(tweened) : value;
  return (
    <View style={[s.tile, hero && s.tileHero]}>
      <View style={s.labelRow}>
        {icon ? <PounceIcon name={icon} size={11} color={theme.colors.fgFaint} /> : null}
        <Text style={s.label}>{label}</Text>
      </View>
      <Text numberOfLines={1} style={[s.value, hero && s.valueHero]}>
        {shown}
      </Text>
      {delta || hint ? (
        <View style={s.footRow}>
          {delta ? (
            <Text style={[s.delta, { color: good ? theme.colors.success : theme.colors.warning }]}>
              {delta}
            </Text>
          ) : null}
          {hint ? (
            <Text numberOfLines={1} style={s.hint}>
              {hint}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create((theme) => ({
  tile: {
    flex: 1,
    minWidth: 130,
    gap: 4,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
    padding: 14,
  },
  tileHero: {
    borderColor: "rgba(124, 111, 240, 0.4)",
    backgroundColor: "rgba(124, 111, 240, 0.08)",
  },
  labelRow: { flexDirection: "row", alignItems: "center", gap: 4 },
  label: {
    fontSize: 11,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    color: theme.colors.fgFaint,
  },
  value: { fontFamily: "JetBrainsMono", fontSize: 22, fontWeight: "600", color: theme.colors.fg },
  valueHero: { fontSize: 30, color: theme.colors.accent },
  footRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  delta: { fontSize: 11, fontWeight: "600" },
  hint: { flex: 1, fontSize: 11, color: theme.colors.fgFaint },
}));
