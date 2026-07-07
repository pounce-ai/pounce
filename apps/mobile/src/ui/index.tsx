import type { ComponentProps } from "react";
import { twMerge } from "tailwind-merge";
import { View, Text } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { ActivityStatus } from "@litter/shared";
import { AgentLogo } from "./agent-logos";

// Shared tokens live in tokens.ts (no circular dep with agent-logos); re-export
// them here so call sites keep importing everything from "@/ui".
export { COLOR, AGENT_LABEL, AGENT_HEX, agentLabel } from "./tokens";
import { agentLabel } from "./tokens";

/** Real brand logos for agents (Claude, Codex, OpenCode, Grok, …). */
export { AgentLogo };

/** Merge Tailwind classes (Uniwind doesn't dedupe; HeroUI ships tailwind-merge). */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return twMerge(parts.filter(Boolean).join(" "));
}

/** Compact relative timestamp: 42s · 7m · 3h · 2d. */
export function timeAgo(iso: string): string {
  const s = Math.max(1, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
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
}: {
  name: string;
  color: string;
  size?: number;
}) {
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
