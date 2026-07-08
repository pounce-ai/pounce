import type { ReactNode } from "react";
import { Modal, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useSelector } from "@legendapp/state/react";
import { Ionicons } from "@expo/vector-icons";
import {
  allAgentsInUse,
  allDevices,
  CLEARED_FILTERS,
  deviceEmoji,
  deviceLabel,
  deviceOverrides$,
  filters$,
  reposByActivity,
} from "@/state/stores";
import { agentLabel, cn, COLOR, DeviceIcon } from "@/ui";

/** A pill filter toggle. */
function FilterChip({
  label,
  active,
  onPress,
  icon,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  icon?: ReactNode;
}) {
  return (
    <Pressable
      onPress={onPress}
      className={cn(
        "active:opacity-80 h-8 flex-row items-center gap-1.5 rounded-full border px-3",
        active ? "border-accent bg-accent/15" : "border-border bg-surface-alt",
      )}
    >
      {icon}
      <Text numberOfLines={1} className={cn("max-w-[180px] text-[13px]", active ? "text-accent" : "text-fg")}>
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * Shared filter bottom sheet — status · project · device · agent — writing
 * straight to `filters$`, so Home and Search stay in lockstep. Sections only
 * appear when there's a real choice to make (>1 project / device / agent).
 */
export function FilterSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const f = useSelector(() => filters$.get());
  const devices = useSelector(() => allDevices());
  const agents = useSelector(() => allAgentsInUse());
  const repos = useSelector(() => reposByActivity());
  useSelector(() => deviceOverrides$.get());
  const hasFilter = !!(f.agent || f.device || f.repo || f.needsOnly || f.favOnly);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable className="flex-1 bg-black/50" onPress={onClose} />
      <View
        style={{ paddingBottom: insets.bottom + 16 }}
        className="gap-4 rounded-t-3xl border-t border-border bg-bg-elevated px-4 pt-3"
      >
        <View className="h-1 w-10 self-center rounded-full bg-border" />
        <View className="flex-row items-center justify-between">
          <Text className="text-[18px] font-bold text-fg">Filter</Text>
          {hasFilter ? (
            <Pressable
              onPress={() => filters$.set(CLEARED_FILTERS)}
              className="active:opacity-60 flex-row items-center gap-1.5"
            >
              <Ionicons name="close-circle-outline" size={15} color={COLOR.fgMuted} />
              <Text className="text-[13px] text-fg-muted">Clear all</Text>
            </Pressable>
          ) : null}
        </View>

        <View className="gap-1.5">
          <Text className="text-[11px] uppercase tracking-wide text-fg-faint">Show</Text>
          <View className="flex-row flex-wrap gap-2">
            <FilterChip label="Needs you" active={f.needsOnly} onPress={() => filters$.needsOnly.set(true)} />
            <FilterChip label="Everything" active={!f.needsOnly} onPress={() => filters$.needsOnly.set(false)} />
          </View>
        </View>

        {repos.length > 1 ? (
          <View className="gap-1.5">
            <Text className="text-[11px] uppercase tracking-wide text-fg-faint">Project</Text>
            <View className="flex-row flex-wrap gap-2">
              {repos.map((r) => (
                <FilterChip
                  key={r.id}
                  label={r.name}
                  active={f.repo === r.id}
                  onPress={() => filters$.repo.set(f.repo === r.id ? null : r.id)}
                  icon={
                    <Ionicons
                      name="folder-outline"
                      size={12}
                      color={f.repo === r.id ? COLOR.accent : COLOR.fgMuted}
                    />
                  }
                />
              ))}
            </View>
          </View>
        ) : null}

        {devices.length > 1 ? (
          <View className="gap-1.5">
            <Text className="text-[11px] uppercase tracking-wide text-fg-faint">Device</Text>
            <View className="flex-row flex-wrap gap-2">
              {devices.map((d) => (
                <FilterChip
                  key={d.id}
                  label={deviceLabel(d.id, d.name)}
                  active={f.device === d.id}
                  onPress={() => filters$.device.set(f.device === d.id ? null : d.id)}
                  icon={
                    <DeviceIcon
                      name={d.name}
                      emoji={deviceEmoji(d.id)}
                      color={f.device === d.id ? COLOR.accent : COLOR.fgMuted}
                      size={13}
                    />
                  }
                />
              ))}
            </View>
          </View>
        ) : null}

        {agents.length > 1 ? (
          <View className="gap-1.5">
            <Text className="text-[11px] uppercase tracking-wide text-fg-faint">Agent</Text>
            <View className="flex-row flex-wrap gap-2">
              {agents.map((a) => (
                <FilterChip
                  key={a}
                  label={agentLabel(a)}
                  active={f.agent === a}
                  onPress={() => filters$.agent.set(f.agent === a ? null : a)}
                />
              ))}
            </View>
          </View>
        ) : null}

        <Pressable
          onPress={onClose}
          className="active:opacity-90 mt-1 h-12 items-center justify-center rounded-xl bg-accent"
        >
          <Text className="text-[15px] font-semibold text-white">Done</Text>
        </Pressable>
      </View>
    </Modal>
  );
}
