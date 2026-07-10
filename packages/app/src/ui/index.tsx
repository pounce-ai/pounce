import type { ComponentProps } from "react";
import { cn } from "cnfast";
import { Platform, View, Text } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { ActivityStatus } from "@litter/shared";
import { AgentLogo } from "./agent-logos";

// Shared tokens live in tokens.ts (no circular dep with agent-logos); re-export
// them here so call sites keep importing everything from "../ui".
export { COLOR, AGENT_LABEL, AGENT_HEX, agentLabel } from "./tokens";
import { agentLabel, COLOR } from "./tokens";

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

const ACTIVITY_DOT: Record<ActivityStatus, string> = {
  running: "bg-success",
  streaming: "bg-success",
  awaiting_input: "bg-warning",
  completed: "bg-info",
  idle: "bg-fg-faint",
  failed: "bg-danger",
  queued: "bg-warning",
};

export const ACTIVITY_LABEL: Record<ActivityStatus, string> = {
  running: "Running",
  streaming: "Streaming",
  awaiting_input: "Needs you",
  completed: "Done",
  idle: "Idle",
  failed: "Failed",
  queued: "Queued",
};

/** Activity dot — axis A of the two-axis status model. Pulses when it needs you. */
export function ActivityDot({
  status,
  size = 8,
}: {
  status: ActivityStatus;
  size?: number;
}) {
  const active = status === "running" || status === "streaming" || status === "awaiting_input";
  return (
    <View style={{ width: size, height: size }} className="items-center justify-center">
      {active ? (
        <View
          className={cn("absolute rounded-full opacity-30", ACTIVITY_DOT[status])}
          style={{ width: size * 2, height: size * 2 }}
        />
      ) : null}
      <View
        className={cn("rounded-full", ACTIVITY_DOT[status])}
        style={{ width: size, height: size }}
      />
    </View>
  );
}

type IoniconName = ComponentProps<typeof Ionicons>["name"];

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
export function AgentChip({ agent, size = 14 }: { agent: string; size?: number }) {
  return (
    <View className="flex-row items-center gap-1.5">
      <AgentLogo agent={agent} size={size} />
      <Text className="text-[12px] font-medium text-fg-muted">{agentLabel(agent)}</Text>
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
