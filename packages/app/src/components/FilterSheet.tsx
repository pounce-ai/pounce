import { type ReactNode, useMemo, useState } from "react";
import { Modal } from "./AppModal";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
  type ColorValue,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useSelector } from "@legendapp/state/react";
import { PounceIcon } from "../ui/native/Icon";
import {
  activeFilterCount,
  availAgentsForDevices,
  availableAgents,
  branchesInScope,
  CLEARED_FILTERS,
  hasActiveFilter,
  deviceEmoji,
  deviceLabel,
  filters$,
  isRepoIgnored,
  reposByActivity,
  sortAgents,
  type StatusBucket,
  toggleRepoIgnore,
} from "../state/stores";
import {
  useDeviceOverrides,
  useDevices,
  useIgnoredSet,
  useProjects,
  useThreads,
} from "../state/db/hooks";
import { agentLabel, COLOR, DeviceIcon, IS_DESKTOP } from "../ui";
import { T } from "../ui/theme";

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
      style={({ pressed }) => [s.filterBtn, on ? s.filterBtnOn : s.filterBtnOff, pressed && s.pressed80]}
    >
      <PounceIcon name="filter" size={17} color={on ? COLOR.accent : COLOR.fgMuted} />
      {count > 0 ? (
        <View style={s.badge}>
          <Text style={s.badgeText}>{count}</Text>
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
      style={({ pressed }) => [s.chip, active ? s.chipOn : s.chipOff, pressed && s.pressed80]}
    >
      {icon}
      <Text numberOfLines={1} style={[s.chipLabel, active ? s.textAccent : s.textFg]}>
        {label}
      </Text>
    </Pressable>
  );
}

/** The three coarse status buckets, each with the dot colour ActivityDot uses. */
const STATUS_CHIPS: { bucket: StatusBucket; label: string; dot: ColorValue }[] = [
  { bucket: "active", label: "Active", dot: T.success },
  { bucket: "idle", label: "Idle", dot: T.fgFaint },
  { bucket: "done", label: "Done", dot: T.info },
];

/**
 * Shared filter bottom sheet — show · status · device · agent · branch · project
 * — writing straight to `filters$`, so Home and Search stay in lockstep. Sections
 * only appear when there's a real choice to make (>1 project / device / agent).
 */
export function FilterSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      {/* KeyboardAvoidingView (RN, not keyboard-controller) — reliable inside an
          RN Modal window; lifts the sheet so the folder search isn't covered. */}
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={s.kav}
      >
        <Pressable style={s.backdrop} onPress={onClose} />
        <View
          style={[s.sheet, { paddingBottom: insets.bottom + 16, maxHeight: Math.round(height * 0.92) }]}
        >
          <FilterSheetContent onClose={onClose} />
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/** The sheet's body — shared by the RN-Modal variant above (desktop) and the
 *  native formSheet route on mobile (apps/mobile app/filters.tsx). The parent
 *  supplies the container (backdrop/sheet chrome) and vertical gap. */
export function FilterSheetContent({ onClose }: { onClose: () => void }) {
  const { height } = useWindowDimensions();
  const f = useSelector(() => filters$.get());
  const devices = useDevices();
  const rawThreads = useThreads();
  const projectList = useProjects();
  // Offer agents the host reports as available (installed + configured), plus any
  // that appear in existing threads (so you can still filter old sessions of an
  // agent that's since been uninstalled). Respects the selected device.
  const agents = useMemo(
    () => sortAgents([...availAgentsForDevices(devices, f.device), ...availableAgents(rawThreads, f.device)]),
    [devices, rawThreads, f.device],
  );
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
  const toggleStatus = (b: StatusBucket) =>
    filters$.statuses.set(
      f.statuses.includes(b) ? f.statuses.filter((x) => x !== b) : [...f.statuses, b],
    );
  // Distinct branch/worktree values for the searchable list; the query both
  // narrows the list and (as before) live-filters the thread list by substring.
  const branchOptions = useMemo(() => branchesInScope(rawThreads), [rawThreads]);
  const shownBranches = useMemo(() => {
    const q = f.branchQuery.trim().toLowerCase();
    return q ? branchOptions.filter((b) => b.toLowerCase().includes(q)) : branchOptions;
  }, [branchOptions, f.branchQuery]);

  return (
    <>
      {/* Grabber doubles as an expand/collapse toggle. */}
        <Pressable onPress={() => setExpanded((v) => !v)} hitSlop={12} style={s.grabber}>
          <View style={s.grabberBar} />
          <PounceIcon name={expanded ? "chevron-down" : "chevron-up"} size={12} color={COLOR.fgFaint} />
        </Pressable>
        <View style={s.rowBetween}>
          <Text style={s.title}>Filter</Text>
          {hasFilter ? (
            <Pressable
              onPress={() => filters$.set(CLEARED_FILTERS)}
              style={({ pressed }) => [s.clearRow, pressed && s.pressed60]}
            >
              <PounceIcon name="close-circle-outline" size={15} color={COLOR.fgMuted} />
              <Text style={s.clearText}>Clear all</Text>
            </Pressable>
          ) : null}
        </View>

        <View style={s.section}>
          <Text style={s.sectionLabel}>Show</Text>
          <View style={s.chipsWrap}>
            <FilterChip label="Needs you" active={f.needsOnly} onPress={() => filters$.needsOnly.set(true)} />
            <FilterChip label="Everything" active={!f.needsOnly} onPress={() => filters$.needsOnly.set(false)} />
          </View>
        </View>

        {/* Status — coarse buckets over the activity axis (multi-select; none = all). */}
        <View style={s.section}>
          <Text style={s.sectionLabel}>Status</Text>
          <View style={s.chipsWrap}>
            {STATUS_CHIPS.map((c) => (
              <FilterChip
                key={c.bucket}
                label={c.label}
                active={f.statuses.includes(c.bucket)}
                onPress={() => toggleStatus(c.bucket)}
                icon={<View style={[s.statusDot, { backgroundColor: c.dot }]} />}
              />
            ))}
          </View>
        </View>

        {devices.length > 1 ? (
          <View style={s.section}>
            <Text style={s.sectionLabel}>Device</Text>
            <View style={s.chipsWrap}>
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
          <View style={s.section}>
            <Text style={s.sectionLabel}>Agent</Text>
            <View style={s.chipsWrap}>
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

        {/* Branch / worktree — a searchable list of the distinct branches and
            worktrees in scope. Typing narrows the list and (as before) live-
            filters threads by substring; tapping a row pins that exact value. */}
        {branchOptions.length ? (
          <View style={s.section}>
            <View style={s.rowBetween}>
              <Text style={s.sectionLabel}>Branch / worktree</Text>
              {f.branchQuery ? (
                <Pressable onPress={() => filters$.branchQuery.set("")} style={({ pressed }) => pressed && s.pressed60}>
                  <Text style={s.clearSmall}>Clear</Text>
                </Pressable>
              ) : null}
            </View>
            <View style={s.searchRow}>
              <PounceIcon name="git-branch-outline" size={14} color={COLOR.fgFaint} />
              <TextInput
                value={f.branchQuery}
                onChangeText={(t) => filters$.branchQuery.set(t)}
                placeholder="Search branch or worktree…"
                placeholderTextColor={COLOR.fgFaint}
                autoCapitalize="none"
                autoCorrect={false}
                style={[s.input, IS_DESKTOP && s.inputDesktop]}
              />
              {f.branchQuery ? (
                <Pressable onPress={() => filters$.branchQuery.set("")} hitSlop={8} style={({ pressed }) => pressed && s.pressed60}>
                  <PounceIcon name="close-circle" size={15} color={COLOR.fgFaint} />
                </Pressable>
              ) : null}
            </View>
            <ScrollView style={{ maxHeight: 180 }} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
              {shownBranches.map((b) => {
                const active = f.branchQuery === b;
                return (
                  <Pressable
                    key={b}
                    onPress={() => filters$.branchQuery.set(active ? "" : b)}
                    style={({ pressed }) => [s.optionRow, pressed && s.pressedHover]}
                  >
                    <PounceIcon
                      name={active ? "checkmark-circle" : "git-branch-outline"}
                      size={16}
                      color={active ? COLOR.accent : COLOR.fgMuted}
                    />
                    <Text
                      numberOfLines={1}
                      style={[s.optionText, active ? s.textAccent : s.textFg]}
                    >
                      {b}
                    </Text>
                  </Pressable>
                );
              })}
              {shownBranches.length === 0 ? (
                <Text style={s.emptyText}>No branches match.</Text>
              ) : null}
            </ScrollView>
          </View>
        ) : null}

        {/* Project last — its searchable, scrollable list is the tallest section,
            so the compact Device/Agent chips read first above it. */}
        {repos.length > 1 ? (
          <View style={s.section}>
            <View style={s.rowBetween}>
              <Text style={s.sectionLabel}>Project</Text>
              {f.repos.length ? (
                <Pressable onPress={() => filters$.repos.set([])} style={({ pressed }) => pressed && s.pressed60}>
                  <Text style={s.clearSmall}>Clear ({f.repos.length})</Text>
                </Pressable>
              ) : null}
            </View>
            {/* Searchable, multi-select folder list. Tap a row to toggle it in the
                filter; tap the eye to permanently hide a folder everywhere. */}
            <View style={s.searchRow}>
              <PounceIcon name="search" size={14} color={COLOR.fgFaint} />
              <TextInput
                value={repoQuery}
                onChangeText={setRepoQuery}
                placeholder="Search folders…"
                placeholderTextColor={COLOR.fgFaint}
                autoCapitalize="none"
                autoCorrect={false}
                style={[s.input, IS_DESKTOP && s.inputDesktop]}
              />
            </View>
            <ScrollView style={{ maxHeight: folderMax }} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
              {shownRepos.map((r) => {
                const ignored = isRepoIgnored(r.id);
                const selected = f.repos.includes(r.id);
                return (
                  <View key={r.id} style={s.repoRow}>
                    <Pressable
                      disabled={ignored}
                      onPress={() =>
                        filters$.repos.set(
                          selected ? f.repos.filter((id) => id !== r.id) : [...f.repos, r.id],
                        )
                      }
                      style={({ pressed }) => [s.optionRow, s.flex1, pressed && s.pressedHover]}
                    >
                      <PounceIcon
                        name={selected ? "checkbox" : "square-outline"}
                        size={18}
                        color={ignored ? COLOR.fgFaint : selected ? COLOR.accent : COLOR.fgMuted}
                      />
                      <PounceIcon name="folder-outline" size={13} color={ignored ? COLOR.fgFaint : COLOR.fgMuted} />
                      <Text
                        numberOfLines={1}
                        style={[
                          s.optionText,
                          ignored ? s.textIgnored : selected ? s.textAccent : s.textFg,
                        ]}
                      >
                        {r.name}
                      </Text>
                    </Pressable>
                    <Pressable onPress={() => toggleRepoIgnore(r.id)} hitSlop={8} style={({ pressed }) => [s.eyeBtn, pressed && s.pressed60]}>
                      <PounceIcon
                        name={ignored ? "eye-off" : "eye-outline"}
                        size={15}
                        color={ignored ? COLOR.accent : COLOR.fgFaint}
                      />
                    </Pressable>
                  </View>
                );
              })}
              {shownRepos.length === 0 ? (
                <Text style={s.emptyText}>No folders match.</Text>
              ) : null}
            </ScrollView>
          </View>
        ) : null}

        <Pressable
          onPress={onClose}
          style={({ pressed }) => [s.doneBtn, pressed && s.pressed90]}
        >
          <Text style={s.doneText}>Done</Text>
        </Pressable>
    </>
  );
}

const s = StyleSheet.create({
  filterBtn: { height: 36, width: 36, alignItems: "center", justifyContent: "center", borderRadius: 999 },
  filterBtnOn: { backgroundColor: T.accentSoft },
  filterBtnOff: { backgroundColor: T.surfaceAlt },
  badge: {
    position: "absolute",
    right: -2,
    top: -2,
    height: 16,
    minWidth: 16,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 999,
    backgroundColor: T.accent,
    paddingHorizontal: 4,
  },
  badgeText: { fontSize: 10, fontWeight: "700", color: T.onAccent },
  chip: {
    height: 32,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 12,
  },
  chipOn: { borderColor: T.accent, backgroundColor: T.accentSoft },
  chipOff: { borderColor: T.border, backgroundColor: T.surfaceAlt },
  chipLabel: { maxWidth: 180, fontSize: 13 },
  textAccent: { color: T.accent },
  textFg: { color: T.fg },
  textIgnored: { color: T.fgFaint, textDecorationLine: "line-through" },
  kav: { flex: 1, justifyContent: "flex-end" },
  backdrop: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: T.overlay },
  sheet: {
    gap: 16,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: 1,
    borderColor: T.border,
    backgroundColor: T.bgElevated,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  grabber: { alignItems: "center", gap: 4, paddingBottom: 2, paddingTop: 2 },
  grabberBar: { height: 4, width: 40, borderRadius: 999, backgroundColor: T.border },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  title: { fontSize: 18, fontWeight: "700", color: T.fg },
  clearRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  clearText: { fontSize: 13, color: T.fgMuted },
  clearSmall: { fontSize: 12, color: T.fgMuted },
  section: { gap: 6 },
  sectionLabel: { fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, color: T.fgFaint },
  chipsWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  statusDot: { height: 8, width: 8, borderRadius: 999 },
  searchRow: {
    height: 36,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: 12,
    backgroundColor: T.surfaceAlt,
    paddingHorizontal: 12,
  },
  input: { flex: 1, fontSize: 14, color: T.fg, height: 36 },
  // react-native-macos top-aligns text inside a fixed-height field, so on
  // desktop the input keeps its intrinsic height (centered by the row's
  // alignItems) and the fixed height lives on the container row instead.
  inputDesktop: { height: "auto" as never, paddingVertical: 0 },
  optionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: 8,
    paddingVertical: 8,
    paddingLeft: 4,
    paddingRight: 8,
  },
  optionText: { flex: 1, fontSize: 14 },
  emptyText: { paddingVertical: 12, textAlign: "center", fontSize: 13, color: T.fgMuted },
  repoRow: { flexDirection: "row", alignItems: "center" },
  flex1: { flex: 1 },
  eyeBtn: { paddingHorizontal: 8, paddingVertical: 8 },
  doneBtn: {
    marginTop: 4,
    height: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 12,
    backgroundColor: T.accent,
  },
  doneText: { fontSize: 15, fontWeight: "600", color: T.onAccent },
  pressed60: { opacity: 0.6 },
  pressed80: { opacity: 0.8 },
  pressed90: { opacity: 0.9 },
  pressedHover: { backgroundColor: T.surfaceHover },
});
