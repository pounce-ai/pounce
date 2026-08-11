import { useSyncExternalStore } from "react";
import {
  ActionSheetIOS,
  Alert,
  Platform,
  View,
  Text,
  type ColorValue,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { PounceIcon } from "./native/Icon";
import type { IoniconName } from "./native/icon-map";
import type { ActivityStatus } from "@pounce/shared";
import { AgentLogo } from "./AgentLogo";
import { useAgentHex } from "./useThemeHex";
import { openSheet } from "./sheet";

// Shared tokens live in tokens.ts (no circular dep with AgentLogo); re-export
// them here so call sites keep importing everything from "../ui".
export { COLOR, AGENT_LABEL, AGENT_HEX, agentLabel } from "./tokens";
import { agentLabel } from "./tokens";

/** Real brand logos for agents (Claude, Codex, OpenCode, Grok, …). */
export { AgentLogo };

/**
 * Extra TextInput props for the desktop platforms. react-native-macos draws a
 * bright native focus ring around focused fields that fights the app's own
 * input chrome. Spread FIRST (`{...INPUT_TWEAKS}`) so per-input props still win.
 */
export const INPUT_TWEAKS: Record<string, unknown> =
  Platform.OS === "macos" || Platform.OS === "windows" ? { enableFocusRing: false } : {};

/** True on the desktop platforms (macOS/Windows) — for tiny layout forks. */
export const IS_DESKTOP = Platform.OS === "macos" || Platform.OS === "windows";

/**
 * `selectable={SELECT_TEXT}` on a label a user will want to copy — a path, a
 * branch, a project name. Desktop only: with a mouse, text you cannot drag a
 * cursor through reads as broken, while on a phone the same prop turns an
 * ordinary long-press into a selection handle nobody asked for.
 *
 * Only for text with NO Pressable ancestor. A selectable RCTText takes the
 * mouse-down on macOS, so the row above it stops responding to clicks — the
 * same swallow noted on Timeline's meta row and ContributionGraph's SVG.
 */
export const SELECT_TEXT = IS_DESKTOP;

/** Compact duration bucket: 45s / 12m / 3h / 6d (floored). */
export function fmtDuration(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function timeAgo(iso: string): string {
  return fmtDuration(Math.max(1, (Date.now() - Date.parse(iso)) / 1000));
}

export const ACTIVITY_LABEL: Record<ActivityStatus, string> = {
  running: "Running",
  streaming: "Streaming",
  awaiting_input: "Needs you",
  completed: "Done",
  idle: "Idle",
  failed: "Failed",
  queued: "Queued",
};

/**
 * Platform picker: NSAlert buttons on desktop, a system action sheet on iOS, a
 * bottom sheet on Android.
 *
 * The Android branch is not decoration. ActionSheetIOS is iOS-only and fails
 * SILENTLY elsewhere, so every menu routed through here — and the several that
 * used to call ActionSheetIOS directly — did nothing at all on Android. The
 * sheet it opens is drawn by `SheetHost`, which Providers mounts once; see
 * ui/sheet.tsx for why Alert.alert couldn't stand in.
 *
 * `title` is optional because some menus are a bare list of verbs and a heading
 * would just be the word the user already long-pressed.
 */
export function pickSheet(
  title: string | undefined,
  labels: string[],
  onPick: (i: number) => void,
): void {
  if (IS_DESKTOP) {
    Alert.alert(title ?? "", undefined, [
      ...labels.map((text, i) => ({ text, onPress: () => onPick(i) })),
      { text: "Cancel", style: "cancel" as const },
    ]);
    return;
  }
  if (Platform.OS === "android") {
    openSheet({
      title,
      labels,
      onPick: (i) => {
        if (i >= 0 && i < labels.length) onPick(i);
      },
    });
    return;
  }
  ActionSheetIOS.showActionSheetWithOptions(
    { title, options: [...labels, "Cancel"], cancelButtonIndex: labels.length },
    (i) => {
      if (i >= 0 && i < labels.length) onPick(i);
    },
  );
}

/** Infer a device-type icon from the machine's name (Mac mini, MacBook, etc.). */
export function deviceIconName(name: string): IoniconName {
  const n = name.toLowerCase();
  if (/(macbook|laptop|\bbook\b|\bair\b|notebook)/.test(n)) return "laptop-outline";
  if (/(iphone|ipad|phone|mobile|android|pixel)/.test(n)) return "phone-portrait-outline";
  if (/(server|ssh|\bvm\b|ec2|remote|cloud|linux|ubuntu|debian|docker|droplet|\bpi\b)/.test(n))
    return "server-outline";
  // mini / studio / imac / mac pro / tower / desktop → a desktop Mac
  return "desktop-outline";
}

export function DeviceIcon({
  name,
  color,
  size = 14,
  emoji,
}: {
  name: string;
  color: ColorValue;
  size?: number;
  /** When set, replaces the inferred device glyph with the user's emoji. */
  emoji?: string;
}) {
  if (emoji) {
    return (
      <Text style={{ fontSize: size, lineHeight: size + 2 }} allowFontScaling={false}>
        {emoji}
      </Text>
    );
  }
  return <PounceIcon name={deviceIconName(name)} size={size} color={color} />;
}

/** Agent identity: real brand logo + name. The single, uniform way to show an
 * agent everywhere (filter, cards, session header). */
export function AgentChip({
  agent,
  size = 14,
  activity,
}: {
  agent: string;
  size?: number;
  /** When provided, the logo doubles as the status indicator. */
  activity?: ActivityStatus;
}) {
  return (
    <View style={s.agentChip}>
      {activity ? (
        <AgentStatusIcon agent={agent} activity={activity} size={size} />
      ) : (
        <AgentLogo agent={agent} size={size} />
      )}
      <Text style={s.agentChipLabel}>{agentLabel(agent)}</Text>
    </View>
  );
}

/** Claude Code's thinking glyphs — a starburst that grows and shrinks. The
 *  cycle runs forward then back so it breathes instead of snapping.
 *  U+FE0E forces text presentation: bare ✳ (and friends) otherwise render as
 *  their emoji variant on iOS — a green square that ignores the text color. */
const VS = "\uFE0E";
const THINKING_GLYPHS = [
  `·${VS}`,
  `✢${VS}`,
  `✳${VS}`,
  `✶${VS}`,
  `✽${VS}`,
  `✶${VS}`,
  `✳${VS}`,
  `✢${VS}`,
];
const THINKING_FRAME_MS = 160;

// One shared ticker for every animating icon: N running threads would
// otherwise each run their own 6.25Hz timer. The interval only exists while
// at least one icon is subscribed, and all icons animate in phase.
let tickFrame = 0;
let tickTimer: ReturnType<typeof setInterval> | null = null;
const tickListeners = new Set<() => void>();
function subscribeTicker(fn: () => void): () => void {
  tickListeners.add(fn);
  tickTimer ??= setInterval(() => {
    tickFrame = (tickFrame + 1) % THINKING_GLYPHS.length;
    tickListeners.forEach((l) => l());
  }, THINKING_FRAME_MS);
  return () => {
    tickListeners.delete(fn);
    if (!tickListeners.size && tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  };
}
const noTick = () => () => {};
const getFrame = () => tickFrame;

/**
 * Agent logo doubling as the status indicator (replaces logo + ActivityDot).
 * While the agent works it becomes Claude Code's morphing-asterisk thinking
 * animation, tinted the agent's brand color; at rest it's the plain logo, and
 * a done thread wears a tiny lock.
 */
export function AgentStatusIcon({
  agent,
  activity,
  size = 13,
  animated = true,
}: {
  agent: string;
  activity: ActivityStatus;
  size?: number;
  /** false = never animate (e.g. the open thread, whose own header already
   *  shows the live state) — the static logo + lock badge still render. */
  animated?: boolean;
}) {
  const { theme } = useUnistyles();
  // Same reason as AgentLogo, and the same ground: the thinking glyph is tinted
  // with a plain brand hex, picked for the ground the APP is painting on rather
  // than the platform trait.
  const hueOf = useAgentHex();
  const active =
    animated && (activity === "running" || activity === "streaming" || activity === "queued");
  const frame = useSyncExternalStore(active ? subscribeTicker : noTick, getFrame);

  if (active) {
    return (
      <View style={[s.center, { width: size, height: size }]}>
        <Text
          allowFontScaling={false}
          style={{
            color: hueOf(agent, theme.colors.accent as string),
            fontSize: size + 1,
            lineHeight: size + 3,
            textAlign: "center",
          }}
        >
          {THINKING_GLYPHS[frame]}
        </Text>
      </View>
    );
  }

  const badge = size * 0.72;
  return (
    <View>
      <AgentLogo agent={agent} size={size} />
      {activity === "completed" ? (
        <View
          style={[
            s.lockBadge,
            { right: -badge * 0.35, bottom: -badge * 0.3, width: badge, height: badge },
          ]}
        >
          <PounceIcon name="lock-closed" size={badge * 0.68} color={theme.colors.fgMuted} />
        </View>
      ) : null}
    </View>
  );
}

/** Branch/worktree label with the matching glyph — a git branch (`git-branch`)
 *  vs a worktree checkout (`git-network`). The single, uniform way to show a
 *  session's branch everywhere (list card, session header). */
export function BranchChip({
  branch,
  worktree,
  size = 11,
  color,
  style,
}: {
  branch: string;
  worktree?: string | null;
  size?: number;
  color?: ColorValue;
  style?: StyleProp<ViewStyle>;
}) {
  const { theme } = useUnistyles();
  const tint = color ?? theme.colors.fgMuted;
  return (
    <View style={[s.branchChip, style]}>
      <PounceIcon
        name={worktree ? "git-network-outline" : "git-branch-outline"}
        size={size}
        color={tint}
      />
      <Text numberOfLines={1} style={[s.branchText, { color: tint, fontSize: size + 1 }]}>
        {branch}
      </Text>
    </View>
  );
}

/** Git/merge-readiness chip — axis B. */
export function MergeChip({ state }: { state: "ready" | "conflicts" | "uncommitted" | "clean" }) {
  const map: Record<"ready" | "conflicts" | "uncommitted" | "clean", [string, TextStyle]> = {
    ready: ["Ready to merge", s.mergeReady],
    conflicts: ["Conflicts", s.mergeConflicts],
    uncommitted: ["Uncommitted", s.mergeUncommitted],
    clean: ["No changes", s.mergeClean],
  };
  const [label, style] = map[state];
  return <Text style={[s.mergeChip, style]}>{label}</Text>;
}

const s = StyleSheet.create((theme) => ({
  agentChip: { flexDirection: "row", alignItems: "center", gap: 6 },
  agentChipLabel: { fontSize: 12, fontWeight: "500", color: theme.colors.fgMuted },
  center: { alignItems: "center", justifyContent: "center" },
  lockBadge: {
    position: "absolute",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 999,
    backgroundColor: theme.colors.bgElevated,
  },
  branchChip: { flexDirection: "row", alignItems: "center", gap: 4 },
  branchText: { flexShrink: 1, fontFamily: "JetBrainsMono" },
  mergeChip: {
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
    fontSize: 11,
    fontWeight: "500",
  },
  // status colors at 10% — no /10 tokens in T; literals from the status hexes.
  mergeReady: { color: theme.colors.success, backgroundColor: "rgba(63, 185, 80, 0.1)" },
  mergeConflicts: { color: theme.colors.danger, backgroundColor: "rgba(248, 81, 73, 0.1)" },
  mergeUncommitted: { color: theme.colors.info, backgroundColor: "rgba(88, 166, 255, 0.1)" },
  mergeClean: { color: theme.colors.fgFaint, backgroundColor: theme.colors.surfaceAlt },
}));
