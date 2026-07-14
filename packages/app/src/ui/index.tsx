import { type ComponentProps, useEffect, useSyncExternalStore } from "react";
import { cn } from "cnfast";
import { ActionSheetIOS, Alert, Platform, View, Text } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { ActivityStatus } from "@litter/shared";
import { AgentLogo } from "./agent-logos";

// Shared tokens live in tokens.ts (no circular dep with agent-logos); re-export
// them here so call sites keep importing everything from "../ui".
export { COLOR, AGENT_LABEL, AGENT_HEX, agentLabel } from "./tokens";
import { AGENT_HEX, agentLabel, COLOR } from "./tokens";

/** Real brand logos for agents (Claude, Codex, OpenCode, Grok, …). */
export { AgentLogo };

/** Merge Tailwind classes (Uniwind doesn't dedupe). cnfast is a drop-in for the
 *  clsx+tailwind-merge combo — byte-identical output, ~3.8x faster. */
export { cn };

/**
 * Extra TextInput props for the desktop platforms. react-native-macos draws a
 * bright native focus ring around focused fields that fights the app's own
 * input chrome. Spread FIRST (`{...INPUT_TWEAKS}`) so per-input props still win.
 */
export const INPUT_TWEAKS: Record<string, unknown> =
  Platform.OS === "macos" || Platform.OS === "windows"
    ? { enableFocusRing: false }
    : {};

/** True on the desktop platforms (macOS/Windows) — for tiny layout forks. */
export const IS_DESKTOP = Platform.OS === "macos" || Platform.OS === "windows";

/**
 * Height classes for a single-line TextInput. react-native-macos top-aligns
 * text (and placeholders) inside a fixed-height field, so on desktop the input
 * keeps its intrinsic height — centered by the row's items-center — and the
 * fixed height belongs on the CONTAINER row instead. Mobile keeps the height
 * on the input for the full-height tap target.
 */
export const inputH = (h: string): string => (IS_DESKTOP ? "py-0" : h);

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

type IoniconName = ComponentProps<typeof Ionicons>["name"];

/** Platform picker: NSAlert buttons on desktop, an action sheet on mobile. */
export function pickSheet(title: string, labels: string[], onPick: (i: number) => void): void {
  if (IS_DESKTOP) {
    Alert.alert(title, undefined, [
      ...labels.map((text, i) => ({ text, onPress: () => onPick(i) })),
      { text: "Cancel", style: "cancel" as const },
    ]);
    return;
  }
  ActionSheetIOS.showActionSheetWithOptions(
    { title, options: [...labels, "Cancel"], cancelButtonIndex: labels.length },
    (i) => { if (i >= 0 && i < labels.length) onPick(i); },
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
  color: string;
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
  return <Ionicons name={deviceIconName(name)} size={size} color={color} />;
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
    <View className="flex-row items-center gap-1.5">
      {activity ? (
        <AgentStatusIcon agent={agent} activity={activity} size={size} />
      ) : (
        <AgentLogo agent={agent} size={size} />
      )}
      <Text className="text-[12px] font-medium text-fg-muted">{agentLabel(agent)}</Text>
    </View>
  );
}

/** Claude Code's thinking glyphs — a starburst that grows and shrinks. The
 *  cycle runs forward then back so it breathes instead of snapping.
 *  U+FE0E forces text presentation: bare ✳ (and friends) otherwise render as
 *  their emoji variant on iOS — a green square that ignores the text color. */
const T = "\uFE0E";
const THINKING_GLYPHS = [`·${T}`, `✢${T}`, `✳${T}`, `✶${T}`, `✽${T}`, `✶${T}`, `✳${T}`, `✢${T}`];
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
  const active =
    animated && (activity === "running" || activity === "streaming" || activity === "queued");
  const frame = useSyncExternalStore(active ? subscribeTicker : noTick, getFrame);

  if (active) {
    return (
      <View style={{ width: size, height: size }} className="items-center justify-center">
        <Text
          allowFontScaling={false}
          style={{
            color: AGENT_HEX[agent] ?? COLOR.accent,
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
          className="absolute items-center justify-center rounded-full bg-bg-elevated"
          style={{ right: -badge * 0.35, bottom: -badge * 0.3, width: badge, height: badge }}
        >
          <Ionicons name="lock-closed" size={badge * 0.68} color={COLOR.fgMuted} />
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
  color = COLOR.fgMuted,
  className,
}: {
  branch: string;
  worktree?: string | null;
  size?: number;
  color?: string;
  className?: string;
}) {
  return (
    <View className={cn("flex-row items-center gap-1", className)}>
      <Ionicons name={worktree ? "git-network-outline" : "git-branch-outline"} size={size} color={color} />
      <Text numberOfLines={1} style={{ color, fontSize: size + 1 }} className="shrink font-mono">
        {branch}
      </Text>
    </View>
  );
}

/** Git/merge-readiness chip — axis B. */
export function MergeChip({ state }: { state: "ready" | "conflicts" | "uncommitted" | "clean" }) {
  const map = {
    ready: ["Ready to merge", "text-success bg-success/10"],
    conflicts: ["Conflicts", "text-danger bg-danger/10"],
    uncommitted: ["Uncommitted", "text-info bg-info/10"],
    clean: ["No changes", "text-fg-faint bg-surface-alt"],
  } as const;
  const [label, cls] = map[state];
  return (
    <Text className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", cls)}>
      {label}
    </Text>
  );
}
