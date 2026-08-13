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
import { StyleSheet, useUnistyles } from "react-native-unistyles";
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
  type ShowBucket,
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
import { agentLabel, DeviceIcon, IS_DESKTOP } from "../ui";

/**
 * The one filter trigger used in every header (Home, Search). Highlights when a
 * filter is active or the sheet is open, with a count badge — so the two screens
 * share the exact same control instead of drifting.
 */
export function FilterButton({ active, onPress }: { active: boolean; onPress: () => void }) {
  const { theme } = useUnistyles();
  const count = useSelector(() => activeFilterCount());
  const on = active || count > 0;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        s.filterBtn,
        on ? s.filterBtnOn : s.filterBtnOff,
        pressed && s.pressed80,
      ]}
    >
      <PounceIcon name="filter" size={17} color={on ? theme.colors.accent : theme.colors.fgMuted} />
      {count > 0 ? (
        <View style={s.badge}>
          <Text style={s.badgeText}>{count}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

/**
 * How much of the screen the filter sheet occupies on a phone.
 *
 * Shared with the route that presents it (apps/mobile app/_layout.tsx sets the
 * detent, app/filters.tsx sets the matching height) because the sheet's height
 * has to be a number BOTH of them know: the detent decides how tall the sheet
 * is drawn, and the content has to be exactly that tall for the Done bar to sit
 * at the bottom of the viewport rather than at the bottom of the content.
 *
 * Measured on the simulator rather than picked: at 0.86 the content came up
 * ~50pt short of the sheet it was sitting in, which put a visible band of dead
 * card under the Done bar.
 */
export const SHEET_FRACTION = 0.86;

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

/** The Show buckets, in the order a day runs: what's blocked on you, what's
 *  still moving, what you're done with. */
const SHOW_CHIPS: { bucket: ShowBucket; label: string }[] = [
  { bucket: "needs", label: "Needs you" },
  { bucket: "active", label: "Active" },
  { bucket: "settled", label: "Settled" },
];

/** The three coarse status buckets, each with the dot colour ActivityDot uses.
 *  Theme token keys — resolved against the live theme at render time. */
const STATUS_CHIPS: { bucket: StatusBucket; label: string; dot: "success" | "fgFaint" | "info" }[] =
  [
    { bucket: "active", label: "Active", dot: "success" },
    { bucket: "idle", label: "Idle", dot: "fgFaint" },
    { bucket: "done", label: "Done", dot: "info" },
  ];

/**
 * Shared filter bottom sheet — show · status · device · agent · branch · project
 * — writing straight to `filters$`, so Home and Search stay in lockstep. Sections
 * only appear when there's a real choice to make (>1 project / device / agent).
 */
export function FilterSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { height } = useWindowDimensions();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      {/* KeyboardAvoidingView (RN, not keyboard-controller) — reliable inside an
          RN Modal window; lifts the sheet so the folder search isn't covered. */}
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={s.kav}>
        <Pressable style={s.backdrop} onPress={onClose} />
        {/* This card used to CLIP everything past 92% of the window with no way
            to reach it — and Done, being last, was the first thing to go. The
            body inside is bounded and scrolls now, so the cap bounds it instead
            of hiding it. No `fill`: this card has no definite height of its
            own, so the body has to bound itself. */}
        <View style={[s.sheet, s.sheetPad, { maxHeight: Math.round(height * 0.92) }]}>
          <FilterSheetContent onClose={onClose} />
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/** The sheet's body — shared by the RN-Modal variant above (desktop), the
 *  desktop shell's routed modal card, and the native sheet route on mobile
 *  (apps/mobile app/filters.tsx). The parent supplies only the container
 *  (backdrop / card / sheet chrome and its padding); scrolling, the gap between
 *  sections, and the pinned Done bar belong to the body, so all three
 *  presentations can't disagree about whether Done is reachable. */
/**
 * The branch / project pickers.
 *
 * On a phone these are bounded scrollers inside the sheet — the sheet itself
 * can't grow past the screen. On desktop the sheet is a modal card that already
 * scrolls, and a scroller inside a scroller swallows the trackpad and clips
 * rows mid-height; there the list just flows and the card scrolls it. Both
 * lists are search-narrowed, so length is the user's to control either way.
 */
function OptionList({ maxHeight, children }: { maxHeight: number; children: React.ReactNode }) {
  if (IS_DESKTOP) return <View>{children}</View>;
  return (
    <ScrollView style={{ maxHeight }} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
      {children}
    </ScrollView>
  );
}

export function FilterSheetContent({
  onClose,
  fill = false,
}: {
  onClose: () => void;
  /**
   * Does the parent give this a DEFINITE height to fill?
   *
   * It decides how the scrolling body is bounded, and there is no way to infer
   * it — the desktop shell hands this component a fixed-height card (fill), and
   * both sheet presentations hand it a container that sizes to its content
   * (not fill), where `flex: 1` resolves to zero and the whole sheet renders as
   * a bare Done button. Verified the hard way on the simulator.
   */
  fill?: boolean;
}) {
  const { theme } = useUnistyles();
  const { height } = useWindowDimensions();
  const f = useSelector(() => filters$.get());
  const devices = useDevices();
  const rawThreads = useThreads();
  const projectList = useProjects();
  // Offer agents the host reports as available (installed + configured), plus any
  // that appear in existing threads (so you can still filter old sessions of an
  // agent that's since been uninstalled). Respects the selected device.
  const agents = useMemo(
    () =>
      sortAgents([
        ...availAgentsForDevices(devices, f.device),
        ...availableAgents(rawThreads, f.device),
      ]),
    [devices, rawThreads, f.device],
  );
  const repos = useMemo(
    () => reposByActivity(projectList, rawThreads, { device: f.device, agent: f.agent }),
    [projectList, rawThreads, f.device, f.agent],
  );
  useDeviceOverrides(); // re-render on rename/emoji
  useIgnoredSet(); // re-render on ignore toggle
  const [repoQuery, setRepoQuery] = useState("");
  /** How tall the folder list may get before it scrolls itself.
   *
   *  A fraction of the screen rather than a toggle: the sheet's own `auto`
   *  detent grows to fit this, and dragging it up to the full detent is the
   *  native way to ask for more room. */
  const folderMax = Math.round(height * 0.42);
  /** How tall the scrolling body may get when the parent hasn't given it a
   *  height to fill. Leaves room under it for the Done bar, its safe-area
   *  padding and the sheet's own grabber. */
  const bodyMax = Math.round(height * 0.72);
  const hasFilter = hasActiveFilter();
  const shownRepos = useMemo(() => {
    const q = repoQuery.trim().toLowerCase();
    return q ? repos.filter((r) => r.name.toLowerCase().includes(q)) : repos;
  }, [repos, repoQuery]);
  /**
   * Add or remove one Show bucket.
   *
   * Removing the LAST one is refused rather than allowed-and-explained: an
   * empty Show is a Home screen with nothing on it, reachable by two taps and
   * escapable only by finding your way back to this sheet. Every other filter
   * here can be emptied safely because empty means "all"; this one is the
   * exception, so it gets the guard rather than a new empty state.
   */
  const toggleShow = (b: ShowBucket) => {
    const has = f.show.includes(b);
    if (has && f.show.length === 1) return;
    filters$.show.set(has ? f.show.filter((x) => x !== b) : [...f.show, b]);
  };
  const toggleStatus = (b: StatusBucket) =>
    filters$.statuses.set(
      f.statuses.includes(b) ? f.statuses.filter((x) => x !== b) : [...f.statuses, b],
    );
  // Distinct branch/worktree values for the searchable list; the query both
  // narrows the list and (as before) live-filters the thread list by substring.
  // Only the branches inside the spaces you picked — see the section below for
  // why an unscoped list is noise rather than a filter.
  const branchOptions = useMemo(
    () =>
      branchesInScope(f.repos.length ? rawThreads.filter((t) => f.repos.includes(t.repoId)) : []),
    [rawThreads, f.repos],
  );
  const shownBranches = useMemo(() => {
    const q = f.branchQuery.trim().toLowerCase();
    return q ? branchOptions.filter((b) => b.toLowerCase().includes(q)) : branchOptions;
  }, [branchOptions, f.branchQuery]);

  return (
    <View style={fill ? s.contentFill : undefined}>
      {/* The body scrolls; Done does not. This used to be one flat fragment the
          callers each wrapped in their own ScrollView (or, in the RN-Modal
          case, in nothing at all) — so with enough projects the sheet ran past
          the bottom of the window, taking the only way to dismiss it with them.
          Owning both halves here is what makes the three presentations agree. */}
      <ScrollView
        style={fill ? s.bodyFill : { maxHeight: bodyMax }}
        contentContainerStyle={s.bodyContent}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        {/* No grabber of our own. This content is presented in a REAL native
          sheet (see the root layout's TrueSheet navigator), which draws its own
          handle and, with `detents: ["auto", 1]`, already drags to full height —
          so the hand-rolled bar was a second handle stacked under the system
          one, doing a job the system one does better. */}
        <View style={s.rowBetween}>
          <Text style={s.title}>Filter</Text>
          {hasFilter ? (
            <Pressable
              onPress={() => filters$.set(CLEARED_FILTERS)}
              style={({ pressed }) => [s.clearRow, pressed && s.pressed60]}
            >
              <PounceIcon name="close-circle-outline" size={15} color={theme.colors.fgMuted} />
              <Text style={s.clearText}>Clear all</Text>
            </Pressable>
          ) : null}
        </View>

        {/* Show — three DISJOINT buckets, so this multi-selects like Status does.
          The default is both live ones on and the archive off, which is the
          ordinary "my work" view; drop one to narrow, add Settled to bring the
          archive in alongside rather than instead.

          "Active" was called "Everything" while this was a two-way switch. It
          had to change twice over: it excluded settled threads (so the word was
          a lie), and it was a SUPERSET of "Needs you" (so the two could never
          both be on, which is the thing this group now does). */}
        <View style={s.section}>
          <Text style={s.sectionLabel}>Show</Text>
          <View style={s.chipsWrap}>
            {SHOW_CHIPS.map((c) => (
              <FilterChip
                key={c.bucket}
                label={c.label}
                active={f.show.includes(c.bucket)}
                onPress={() => toggleShow(c.bucket)}
              />
            ))}
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
                icon={<View style={[s.statusDot, { backgroundColor: theme.colors[c.dot] }]} />}
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
                      color={f.device === d.id ? theme.colors.accent : theme.colors.fgMuted}
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

        {/* Space comes before Branch: a branch only means something inside a
            project ("main" exists in all of them), so you pick the place first
            and then narrow within it. */}
        {repos.length > 1 ? (
          <View style={s.section}>
            <View style={s.rowBetween}>
              <Text style={s.sectionLabel}>Space</Text>
              {f.repos.length ? (
                <Pressable
                  onPress={() => filters$.repos.set([])}
                  style={({ pressed }) => pressed && s.pressed60}
                >
                  <Text style={s.clearSmall}>Clear ({f.repos.length})</Text>
                </Pressable>
              ) : null}
            </View>
            {/* Searchable, multi-select list. Tap a row to toggle it in the
                filter; tap the eye to permanently hide a space everywhere. */}
            <View style={s.searchRow}>
              <PounceIcon name="search" size={14} color={theme.colors.fgFaint} />
              <TextInput
                value={repoQuery}
                onChangeText={setRepoQuery}
                placeholder="Search spaces…"
                placeholderTextColor={theme.colors.fgFaint}
                autoCapitalize="none"
                autoCorrect={false}
                style={[s.input, IS_DESKTOP && s.inputDesktop]}
              />
            </View>
            <OptionList maxHeight={folderMax}>
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
                        color={
                          ignored
                            ? theme.colors.fgFaint
                            : selected
                              ? theme.colors.accent
                              : theme.colors.fgMuted
                        }
                      />
                      <PounceIcon
                        name="folder-outline"
                        size={13}
                        color={ignored ? theme.colors.fgFaint : theme.colors.fgMuted}
                      />
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
                    <Pressable
                      onPress={() => toggleRepoIgnore(r.id)}
                      hitSlop={8}
                      style={({ pressed }) => [s.eyeBtn, pressed && s.pressed60]}
                    >
                      <PounceIcon
                        name={ignored ? "eye-off" : "eye-outline"}
                        size={15}
                        color={ignored ? theme.colors.accent : theme.colors.fgFaint}
                      />
                    </Pressable>
                  </View>
                );
              })}
              {shownRepos.length === 0 ? <Text style={s.emptyText}>No spaces match.</Text> : null}
            </OptionList>
          </View>
        ) : null}

        {/* Branch / worktree, scoped to the chosen space(s). Typing narrows the
            list and live-filters threads by substring; tapping a row pins that
            exact value. Hidden until a space is picked: an unscoped list mixes
            every project's branches together, where a dozen identical "main"
            rows tell you nothing about which one you'd be filtering to. */}
        {f.repos.length && branchOptions.length ? (
          <View style={s.section}>
            <View style={s.rowBetween}>
              <Text style={s.sectionLabel}>Branch / worktree</Text>
              {f.branchQuery ? (
                <Pressable
                  onPress={() => filters$.branchQuery.set("")}
                  style={({ pressed }) => pressed && s.pressed60}
                >
                  <Text style={s.clearSmall}>Clear</Text>
                </Pressable>
              ) : null}
            </View>
            <View style={s.searchRow}>
              <PounceIcon name="git-branch-outline" size={14} color={theme.colors.fgFaint} />
              <TextInput
                value={f.branchQuery}
                onChangeText={(t) => filters$.branchQuery.set(t)}
                placeholder="Search branch or worktree…"
                placeholderTextColor={theme.colors.fgFaint}
                autoCapitalize="none"
                autoCorrect={false}
                style={[s.input, IS_DESKTOP && s.inputDesktop]}
              />
              {f.branchQuery ? (
                <Pressable
                  onPress={() => filters$.branchQuery.set("")}
                  hitSlop={8}
                  style={({ pressed }) => pressed && s.pressed60}
                >
                  <PounceIcon name="close-circle" size={15} color={theme.colors.fgFaint} />
                </Pressable>
              ) : null}
            </View>
            <OptionList maxHeight={180}>
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
                      color={active ? theme.colors.accent : theme.colors.fgMuted}
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
            </OptionList>
          </View>
        ) : null}
      </ScrollView>

      {/* Pinned under the scroller, in its own bar: applying the filters is the
          one control that must be reachable from anywhere in the list, and it
          is the only way out of the RN-Modal variant. */}
      <View style={s.footer}>
        <Pressable onPress={onClose} style={({ pressed }) => [s.doneBtn, pressed && s.pressed90]}>
          <Text style={s.doneText}>Done</Text>
        </Pressable>
      </View>
    </View>
  );
}

const s = StyleSheet.create((theme, rt) => ({
  /** Safe-area padding in the sheet — applied natively, no re-render. */
  sheetPad: { paddingBottom: rt.insets.bottom + 16 },
  filterBtn: {
    height: 36,
    width: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 999,
  },
  filterBtnOn: { backgroundColor: theme.colors.accentSoft },
  filterBtnOff: { backgroundColor: theme.colors.surfaceAlt },
  badge: {
    position: "absolute",
    right: -2,
    top: -2,
    height: 16,
    minWidth: 16,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 999,
    backgroundColor: theme.colors.accent,
    paddingHorizontal: 4,
  },
  badgeText: { fontSize: 10, fontWeight: "700", color: theme.colors.onAccent },
  chip: {
    height: 32,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 12,
  },
  chipOn: { borderColor: theme.colors.accent, backgroundColor: theme.colors.accentSoft },
  chipOff: { borderColor: theme.colors.border, backgroundColor: theme.colors.surfaceAlt },
  chipLabel: { maxWidth: 180, fontSize: 13 },
  textAccent: { color: theme.colors.accent },
  textFg: { color: theme.colors.fg },
  textIgnored: { color: theme.colors.fgFaint, textDecorationLine: "line-through" },
  kav: { flex: 1, justifyContent: "flex-end" },
  backdrop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: theme.colors.overlay,
  },
  sheet: {
    gap: 16,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.bgElevated,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  title: { fontSize: 18, fontWeight: "700", color: theme.colors.fg },
  clearRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  clearText: { fontSize: 13, color: theme.colors.fgMuted },
  clearSmall: { fontSize: 12, color: theme.colors.fgMuted },
  section: { gap: 6 },
  sectionLabel: {
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    color: theme.colors.fgFaint,
  },
  chipsWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  statusDot: { height: 8, width: 8, borderRadius: 999 },
  searchRow: {
    height: 36,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: 12,
    backgroundColor: theme.colors.surfaceAlt,
    paddingHorizontal: 12,
  },
  input: { flex: 1, fontSize: 14, color: theme.colors.fg, height: 36 },
  // react-native-macos top-aligns text inside a fixed-height field, so on
  // desktop the input keeps its intrinsic height (centered by the row's
  // alignItems) and the fixed height lives on the container row instead.
  inputDesktop: { height: "auto" as unknown as number, paddingVertical: 0 },
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
  emptyText: {
    paddingVertical: 12,
    textAlign: "center",
    fontSize: 13,
    color: theme.colors.fgMuted,
  },
  repoRow: { flexDirection: "row", alignItems: "center" },
  flex1: { flex: 1 },
  eyeBtn: { paddingHorizontal: 8, paddingVertical: 8 },
  /** Only for a parent with a definite height (see the `fill` prop). Under a
   *  content-measured sheet these collapse to nothing, which is why the sheets
   *  bound the body with an explicit `maxHeight` instead. */
  contentFill: { flex: 1 },
  bodyFill: { flex: 1 },
  /** The gap the callers used to pass in their own contentContainerStyle —
   *  it belongs to the body now that the body lives here. */
  bodyContent: { gap: 16, paddingBottom: 8 },
  footer: {
    // Never squeezed by the scroller above it.
    flexShrink: 0,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.bgElevated,
    paddingTop: 10,
  },
  doneBtn: {
    height: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 12,
    backgroundColor: theme.colors.accent,
  },
  doneText: { fontSize: 15, fontWeight: "600", color: theme.colors.onAccent },
  pressed60: { opacity: 0.6 },
  pressed80: { opacity: 0.8 },
  pressed90: { opacity: 0.9 },
  pressedHover: { backgroundColor: theme.colors.surfaceHover },
}));
