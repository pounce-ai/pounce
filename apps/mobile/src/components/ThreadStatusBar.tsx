import type { ComponentProps } from "react";
import { Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { ThreadUsage } from "@/services/bridge";
import { AgentLogo, cn, COLOR } from "@/ui";

/** A tappable control chip on the status bar (mode, effort). */
interface Control {
  label: string;
  active: boolean;
  onPress: () => void;
}

/** 165_000_000 → "165M", 1_200_000 → "1.2M", 845_000 → "845K", 900 → "900". */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${m >= 100 ? Math.round(m) : m.toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return `${n}`;
}

/** "$6.20", "$0.05", or "<$0.01" for tiny non-zero costs. */
function fmtCost(cost: number): string {
  if (cost > 0 && cost < 0.01) return "<$0.01";
  return `$${cost.toFixed(2)}`;
}

/** "claude-opus-4-8" → "opus 4.8"; "claude-haiku-4-5-20251001" → "haiku 4.5". */
function shortModel(model: string): string {
  return model
    .replace(/^claude-/, "")
    .replace(/-\d{8}$/, "")
    .replace(/-(\d+)-(\d+)$/, " $1.$2")
    .replace(/-(\d+)$/, " $1");
}

/**
 * A thin toolbar above the composer: an interactive model chip, subtle usage
 * chips (tokens · cost), and a markers chip. Everything is left-aligned in its
 * own row of pills with real hit targets — the right side stays clear of the
 * send button so nothing mis-fires into the input.
 */
export function ThreadStatusBar({
  agent,
  usage,
  model,
  canPickModel,
  onPressModel,
  mode,
  effort,
  markerCount,
  onOpenMarkers,
}: {
  agent: string;
  usage: ThreadUsage | null;
  /** Effective model id (selection ?? last-used). */
  model: string | null;
  canPickModel: boolean;
  onPressModel: () => void;
  /** Permission-mode control — null to hide (agent has ≤1 mode). */
  mode: Control | null;
  /** Reasoning-effort control — null to hide (agent has no thinking). */
  effort: Control | null;
  markerCount: number;
  onOpenMarkers: () => void;
}) {
  const hasUsage = !!(usage?.available && usage.tokens);
  return (
    <View className="mb-2.5 flex-row flex-wrap items-center gap-1.5 px-0.5">
      {/* Model — the primary control, a clearly-tappable pill */}
      {model ? (
        <Pressable
          disabled={!canPickModel}
          onPress={onPressModel}
          hitSlop={6}
          className={cn(
            "flex-row items-center gap-1 rounded-full px-2.5 py-1",
            canPickModel ? "active:opacity-70 border border-border bg-surface-alt" : "border border-transparent",
          )}
        >
          <AgentLogo agent={agent} size={12} />
          <Text numberOfLines={1} className="max-w-[130px] text-[12px] font-medium text-fg">
            {shortModel(model)}
          </Text>
          {canPickModel ? <Ionicons name="chevron-down" size={11} color={COLOR.fgFaint} /> : null}
        </Pressable>
      ) : canPickModel ? (
        <Pressable
          onPress={onPressModel}
          hitSlop={6}
          className="active:opacity-70 flex-row items-center gap-1 rounded-full border border-border bg-surface-alt px-2.5 py-1"
        >
          <Ionicons name="cube-outline" size={12} color={COLOR.fgMuted} />
          <Text className="text-[12px] font-medium text-fg-muted">Model</Text>
          <Ionicons name="chevron-down" size={11} color={COLOR.fgFaint} />
        </Pressable>
      ) : null}

      {/* Turn controls — permission mode + reasoning effort */}
      {mode ? (
        <ControlChip icon="git-branch-outline" label={mode.label} active={mode.active} onPress={mode.onPress} />
      ) : null}
      {effort ? (
        <ControlChip icon="flash-outline" label={effort.label} active={effort.active} onPress={effort.onPress} />
      ) : null}

      {/* Usage — subtle, non-interactive info chips */}
      {hasUsage ? (
        <>
          <InfoChip text={`${fmtTokens(usage!.tokens!.total)} tokens`} />
          {usage!.cost != null ? (
            <InfoChip
              text={`${usage!.costComplete === false ? "~" : ""}${fmtCost(usage!.cost)}`}
            />
          ) : null}
        </>
      ) : null}

      {/* Markers — tappable pill */}
      {markerCount > 0 ? (
        <Pressable
          onPress={onOpenMarkers}
          hitSlop={6}
          className="active:opacity-70 flex-row items-center gap-1 rounded-full border border-border bg-surface-alt px-2 py-1"
        >
          <Ionicons name="bookmark" size={11} color={COLOR.accent} />
          <Text className="text-[12px] font-semibold text-fg-muted">{markerCount}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function InfoChip({ text }: { text: string }) {
  return (
    <View className="rounded-full bg-surface-alt px-2 py-1">
      <Text className="text-[12px] text-fg-muted">{text}</Text>
    </View>
  );
}

function ControlChip({
  icon,
  label,
  active,
  onPress,
}: {
  icon: ComponentProps<typeof Ionicons>["name"];
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={6}
      className={cn(
        "active:opacity-70 flex-row items-center gap-1 rounded-full border px-2.5 py-1",
        active ? "border-accent/50 bg-accent-soft" : "border-border bg-surface-alt",
      )}
    >
      <Ionicons name={icon} size={12} color={active ? COLOR.accent : COLOR.fgMuted} />
      <Text className={cn("text-[12px] font-medium", active ? "text-accent" : "text-fg-muted")}>{label}</Text>
      <Ionicons name="chevron-down" size={10} color={active ? COLOR.accent : COLOR.fgFaint} />
    </Pressable>
  );
}
