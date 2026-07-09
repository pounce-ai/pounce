/**
 * Morphing popup panels for the motion tab bar — one per tab. Each tab tap
 * navigates to its screen and morphs open this panel of quick actions.
 * Rendered by AnimatedTabBar (see (app)/(tabs)/_layout.tsx); actions dispatch
 * against expo-router + the global stores, then call `close()` to dismiss.
 */
import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useSelector } from "@legendapp/state/react";
import { Ionicons } from "@expo/vector-icons";
import type { IPalette, IPopupRenderContext, TPopupRenderer } from "@/motion-tabs";
import {
  agentsInScope,
  CLEARED_FILTERS,
  hasActiveFilter,
  connection$,
  deviceEmoji,
  deviceLabel,
  filters$,
} from "@/state/stores";
import { useDeviceOverrides, useDevices, useThreads } from "@/state/db/hooks";
import { refreshLive } from "@/services/runtime";
import { agentLabel } from "@/ui";

type IconName = React.ComponentProps<typeof Ionicons>["name"];

function Row({
  colors,
  icon,
  label,
  hint,
  tint,
  onPress,
}: {
  colors: IPalette;
  icon: IconName;
  label: string;
  hint?: string;
  tint?: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingVertical: 11,
        paddingHorizontal: 12,
        borderRadius: 12,
        backgroundColor: pressed ? colors.hover : "transparent",
      })}
    >
      <Ionicons name={icon} size={20} color={tint ?? colors.muted} />
      <Text style={{ flex: 1, fontSize: 15, fontWeight: "500", color: tint ?? colors.foreground }}>
        {label}
      </Text>
      {hint ? <Text style={{ fontSize: 12, color: colors.muted }}>{hint}</Text> : null}
    </Pressable>
  );
}

function Chip({
  colors,
  label,
  active,
  onPress,
}: {
  colors: IPalette;
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        paddingHorizontal: 12,
        paddingVertical: 7,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: active ? "#7c6ff0" : colors.border,
        backgroundColor: active ? "rgba(124,111,240,0.20)" : colors.input,
      }}
    >
      <Text style={{ fontSize: 13, color: active ? "#a99bff" : colors.foreground }}>{label}</Text>
    </Pressable>
  );
}

/** Home — start / refresh. (Voice moved to the composer as dictation.) */
function HomePopup({ colors, close }: IPopupRenderContext) {
  const router = useRouter();

  return (
    <View style={{ padding: 8, minWidth: 236, gap: 2 }}>
      <Row
        colors={colors}
        icon="add-circle"
        label="New task"
        tint="#7c6ff0"
        onPress={() => {
          close();
          router.push("/new");
        }}
      />
      <Row colors={colors} icon="refresh" label="Refresh" onPress={() => { close(); void refreshLive(true); }} />
    </View>
  );
}

/** Search — the app's one filter surface (status · device · agent). */
function SearchPopup({ colors, close }: IPopupRenderContext) {
  const f = useSelector(() => filters$.get());
  const rawThreads = useThreads();
  const agents = useMemo(() => agentsInScope(rawThreads), [rawThreads]);
  const devices = useDevices();
  useDeviceOverrides();
  const hasFilter = hasActiveFilter();

  return (
    <View style={{ padding: 10, minWidth: 268, gap: 12 }}>
      <View style={{ gap: 6 }}>
        <Text style={{ fontSize: 11, color: colors.muted, paddingHorizontal: 4 }}>Show</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, paddingHorizontal: 4 }}>
          <Chip
            colors={colors}
            label="Everything"
            active={!f.needsOnly && !f.favOnly}
            onPress={() => filters$.set({ ...filters$.get(), needsOnly: false, favOnly: false })}
          />
          <Chip
            colors={colors}
            label="Needs you"
            active={f.needsOnly}
            onPress={() => filters$.needsOnly.set(true)}
          />
          <Chip
            colors={colors}
            label="Favourites"
            active={f.favOnly}
            onPress={() => filters$.favOnly.set(!f.favOnly)}
          />
        </View>
      </View>
      {devices.length > 1 ? (
        <View style={{ gap: 6 }}>
          <Text style={{ fontSize: 11, color: colors.muted, paddingHorizontal: 4 }}>Device</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, paddingHorizontal: 4 }}>
            {devices.map((d) => {
              const em = deviceEmoji(d.id);
              return (
                <Chip
                  key={d.id}
                  colors={colors}
                  label={em ? `${em} ${deviceLabel(d.id, d.name)}` : deviceLabel(d.id, d.name)}
                  active={f.device === d.id}
                  onPress={() => filters$.device.set(f.device === d.id ? null : d.id)}
                />
              );
            })}
          </View>
        </View>
      ) : null}
      {agents.length > 1 ? (
        <View style={{ gap: 6 }}>
          <Text style={{ fontSize: 11, color: colors.muted, paddingHorizontal: 4 }}>Agent</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, paddingHorizontal: 4 }}>
            {agents.map((a) => (
              <Chip
                key={a}
                colors={colors}
                label={agentLabel(a)}
                active={f.agent === a}
                onPress={() => filters$.agent.set(f.agent === a ? null : a)}
              />
            ))}
          </View>
        </View>
      ) : null}
      {hasFilter ? (
        <Row
          colors={colors}
          icon="close-circle-outline"
          label="Clear all"
          onPress={() => {
            filters$.set(CLEARED_FILTERS);
            close();
          }}
        />
      ) : null}
    </View>
  );
}

/** Settings — connection at a glance + a manual resync. */
function SettingsPopup({ colors, close }: IPopupRenderContext) {
  const router = useRouter();
  const status = useSelector(() => connection$.status.get());
  const devices = useDevices();
  const connected = status === "connected";

  return (
    <View style={{ padding: 8, minWidth: 240, gap: 2 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 8 }}>
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: connected ? "#3fb950" : colors.muted }} />
        <Text style={{ fontSize: 13, color: colors.muted }}>
          {connected ? `Connected · ${devices.length} device${devices.length === 1 ? "" : "s"}` : "Not connected"}
        </Text>
      </View>
      <Row colors={colors} icon="refresh" label="Refresh now" onPress={() => { close(); void refreshLive(true); }} />
      <Row
        colors={colors}
        icon="add-outline"
        label="Sync a device"
        onPress={() => {
          close();
          router.push("/settings");
        }}
      />
    </View>
  );
}

/** Route-keyed popup renderer handed to AnimatedTabBar. */
export const PouncePopups: TPopupRenderer = (context) => {
  switch (context.route.name) {
    case "index":
      return <HomePopup {...context} />;
    case "search":
      return <SearchPopup {...context} />;
    default:
      return <SettingsPopup {...context} />;
  }
};
