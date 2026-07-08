import { Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { ThreadUsage } from "@/services/bridge";
import { AgentLogo, cn, COLOR } from "@/ui";

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

/** "claude-opus-4-8" → "opus 4.8"; "claude-haiku-4-5-20251001" → "haiku 4.5";
 *  "sonnet" (alias) → "sonnet". */
function shortModel(model: string): string {
  return model
    .replace(/^claude-/, "")
    .replace(/-\d{8}$/, "")
    .replace(/-(\d+)-(\d+)$/, " $1.$2")
    .replace(/-(\d+)$/, " $1");
}

/**
 * Thin statusline above the composer: tappable model · tokens · cost · markers,
 * all in one left-aligned group (kept clear of the send button). Tokens/cost
 * appear only when usage is available; the model chip always shows for a live
 * thread so you can switch even without usage data.
 */
export function ThreadStatusBar({
  agent,
  usage,
  model,
  canPickModel,
  onPressModel,
  markerCount,
  onOpenMarkers,
}: {
  agent: string;
  usage: ThreadUsage | null;
  /** Effective model id (selection ?? last-used); gets a chevron when pickable. */
  model: string | null;
  canPickModel: boolean;
  onPressModel: () => void;
  markerCount: number;
  onOpenMarkers: () => void;
}) {
  const hasUsage = !!(usage?.available && usage.tokens);
  return (
    <View className="mb-2.5 flex-row items-center px-1">
      <View className="flex-1 flex-row items-center gap-1.5">
        {model ? (
          <ModelChip agent={agent} label={shortModel(model)} pickable={canPickModel} onPress={onPressModel} />
        ) : canPickModel ? (
          <Pressable onPress={onPressModel} hitSlop={6} className="active:opacity-70 flex-row items-center gap-1">
            <Text className="text-[11px] text-fg-muted">Model</Text>
            <Ionicons name="chevron-down" size={10} color={COLOR.fgFaint} />
          </Pressable>
        ) : null}

        {hasUsage ? (
          <>
            {model ? <Dot /> : null}
            <Text className="text-[11px] text-fg-muted">{fmtTokens(usage!.tokens!.total)} tok</Text>
            {usage!.cost != null ? (
              <>
                <Dot />
                <Text className="text-[11px] text-fg-muted">
                  {usage!.costComplete === false ? "~" : ""}
                  {fmtCost(usage!.cost)}
                </Text>
              </>
            ) : null}
          </>
        ) : null}

        {markerCount > 0 ? (
          <Pressable
            onPress={onOpenMarkers}
            hitSlop={8}
            className="active:opacity-70 ml-1 flex-row items-center gap-1 rounded-full border border-border bg-surface-alt px-2 py-0.5"
          >
            <Ionicons name="bookmark" size={10} color={COLOR.accent} />
            <Text className="text-[11px] font-semibold text-fg-muted">{markerCount}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

function ModelChip({
  agent,
  label,
  pickable,
  onPress,
}: {
  agent: string;
  label: string;
  pickable: boolean;
  onPress: () => void;
}) {
  const inner = (
    <>
      <AgentLogo agent={agent} size={11} />
      <Text numberOfLines={1} className={cn("text-[11px]", pickable ? "font-medium text-fg-muted" : "text-fg-muted")}>
        {label}
      </Text>
      {pickable ? <Ionicons name="chevron-down" size={10} color={COLOR.fgFaint} /> : null}
    </>
  );
  return pickable ? (
    <Pressable onPress={onPress} hitSlop={6} className="active:opacity-70 flex-row items-center gap-1">
      {inner}
    </Pressable>
  ) : (
    <View className="flex-row items-center gap-1">{inner}</View>
  );
}

function Dot() {
  return <Text className="text-[11px] text-fg-faint">·</Text>;
}
