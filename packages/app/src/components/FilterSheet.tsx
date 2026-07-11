import { type ReactNode, useMemo, useState } from "react";
import { Modal } from "./AppModal";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useSelector } from "@legendapp/state/react";
import { Ionicons } from "@expo/vector-icons";
import {
  agentsInScope,
  activeFilterCount,
  CLEARED_FILTERS,
  hasActiveFilter,
  deviceEmoji,
  deviceLabel,
  filters$,
  isRepoIgnored,
  reposByActivity,
  toggleRepoIgnore,
} from "../state/stores";
import {
  useDeviceOverrides,
  useDevices,
  useIgnoredSet,
  useProjects,
  useThreads,
} from "../state/db/hooks";
import { agentLabel, cn, COLOR, DeviceIcon } from "../ui";

/**
 * The one filter trigger used in every header (Home, Search). Highlights when a
 * filter is active or the sheet is open, with a count badge — so the two screens
 * share the exact same control instead of drifting.
 */
export function FilterButton({ active, onPress }: { active: boolean; onPress: () => void }) {
  const count = useSelector(() => activeFilterCount());
  const on = active || count > 0;
  return (
    <Pressable
      onPress={onPress}
      className={cn(
        "active:opacity-80 h-9 w-9 items-center justify-center rounded-full",
        on ? "bg-accent/15" : "bg-surface-alt",
      )}
    >
      <Ionicons name="filter" size={17} color={on ? COLOR.accent : COLOR.fgMuted} />
      {count > 0 ? (
        <View className="absolute -right-0.5 -top-0.5 h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1">
          <Text className="text-[10px] font-bold text-white">{count}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

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
  const { height } = useWindowDimensions();
  const f = useSelector(() => filters$.get());
  const devices = useDevices();
  const rawThreads = useThreads();
  const projectList = useProjects();
  const agents = useMemo(() => agentsInScope(rawThreads), [rawThreads]);
  const repos = useMemo(
    () => reposByActivity(projectList, rawThreads, { device: f.device, agent: f.agent }),
    [projectList, rawThreads, f.device, f.agent],
  );
  useDeviceOverrides(); // re-render on rename/emoji
  useIgnoredSet(); // re-render on ignore toggle
  const [repoQuery, setRepoQuery] = useState("");
  // Tap the grabber to expand — gives the (potentially long) folder list far more
  // room without pushing the sheet off-screen by default.
  const [expanded, setExpanded] = useState(false);
  const folderMax = expanded ? Math.round(height * 0.5) : 220;
  const hasFilter = hasActiveFilter();
  const shownRepos = useMemo(() => {
    const q = repoQuery.trim().toLowerCase();
    return q ? repos.filter((r) => r.name.toLowerCase().includes(q)) : repos;
  }, [repos, repoQuery]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      {/* KeyboardAvoidingView (RN, not keyboard-controller) — reliable inside an
          RN Modal window; lifts the sheet so the folder search isn't covered. */}
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        className="flex-1 justify-end"
      >
        <Pressable className="absolute inset-0 bg-black/50" onPress={onClose} />
        <View
          style={{ paddingBottom: insets.bottom + 16, maxHeight: Math.round(height * 0.92) }}
          className="gap-4 rounded-t-3xl border-t border-border bg-bg-elevated px-4 pt-3"
        >
        {/* Grabber doubles as an expand/collapse toggle. */}
        <Pressable onPress={() => setExpanded((v) => !v)} hitSlop={12} className="items-center gap-1 pb-0.5 pt-0.5">
          <View className="h-1 w-10 rounded-full bg-border" />
          <Ionicons name={expanded ? "chevron-down" : "chevron-up"} size={12} color={COLOR.fgFaint} />
        </Pressable>
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

        {/* Project last — its searchable, scrollable list is the tallest section,
            so the compact Device/Agent chips read first above it. */}
        {repos.length > 1 ? (
          <View className="gap-1.5">
            <View className="flex-row items-center justify-between">
              <Text className="text-[11px] uppercase tracking-wide text-fg-faint">Project</Text>
              {f.repos.length ? (
                <Pressable onPress={() => filters$.repos.set([])} className="active:opacity-60">
                  <Text className="text-[12px] text-fg-muted">Clear ({f.repos.length})</Text>
                </Pressable>
              ) : null}
            </View>
            {/* Searchable, multi-select folder list. Tap a row to toggle it in the
                filter; tap the eye to permanently hide a folder everywhere. */}
            <View className="flex-row items-center gap-2 rounded-xl bg-surface-alt px-3">
              <Ionicons name="search" size={14} color={COLOR.fgFaint} />
              <TextInput
                value={repoQuery}
                onChangeText={setRepoQuery}
                placeholder="Search folders…"
                placeholderTextColor={COLOR.fgFaint}
                autoCapitalize="none"
                autoCorrect={false}
                className="h-9 flex-1 text-[14px] text-fg"
              />
            </View>
            <ScrollView style={{ maxHeight: folderMax }} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
              {shownRepos.map((r) => {
                const ignored = isRepoIgnored(r.id);
                const selected = f.repos.includes(r.id);
                return (
                  <View key={r.id} className="flex-row items-center">
                    <Pressable
                      disabled={ignored}
                      onPress={() =>
                        filters$.repos.set(
                          selected ? f.repos.filter((id) => id !== r.id) : [...f.repos, r.id],
                        )
                      }
                      className="active:bg-surface-hover flex-1 flex-row items-center gap-2 rounded-lg py-2 pl-1 pr-2"
                    >
                      <Ionicons
                        name={selected ? "checkbox" : "square-outline"}
                        size={18}
                        color={ignored ? COLOR.fgFaint : selected ? COLOR.accent : COLOR.fgMuted}
                      />
                      <Ionicons name="folder-outline" size={13} color={ignored ? COLOR.fgFaint : COLOR.fgMuted} />
                      <Text
                        numberOfLines={1}
                        className={cn(
                          "flex-1 text-[14px]",
                          ignored ? "text-fg-faint line-through" : selected ? "text-accent" : "text-fg",
                        )}
                      >
                        {r.name}
                      </Text>
                    </Pressable>
                    <Pressable onPress={() => toggleRepoIgnore(r.id)} hitSlop={8} className="active:opacity-60 px-2 py-2">
                      <Ionicons
                        name={ignored ? "eye-off" : "eye-outline"}
                        size={15}
                        color={ignored ? COLOR.accent : COLOR.fgFaint}
                      />
                    </Pressable>
                  </View>
                );
              })}
              {shownRepos.length === 0 ? (
                <Text className="py-3 text-center text-[13px] text-fg-muted">No folders match.</Text>
              ) : null}
            </ScrollView>
          </View>
        ) : null}

        <Pressable
          onPress={onClose}
          className="active:opacity-90 mt-1 h-12 items-center justify-center rounded-xl bg-accent"
        >
          <Text className="text-[15px] font-semibold text-white">Done</Text>
        </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
