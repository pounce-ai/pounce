import { Pressable, Text, View } from "react-native";
import { useRouter } from "expo-router";
import type { Session } from "@litter/shared";
import { ActivityDot, ACTIVITY_LABEL, AgentChip, BranchChip, cn, timeAgo } from "@/ui";

export function SessionCard({
  session,
  onLongPress,
}: {
  session: Session;
  onLongPress?: (session: Session) => void;
}) {
  const router = useRouter();
  const needs = session.needsAttention;
  return (
    <Pressable
      onPress={() => router.push(`/session/${session.id}`)}
      onLongPress={onLongPress ? () => onLongPress(session) : undefined}
      delayLongPress={350}
      className={cn(
        "active:bg-surface-hover rounded-2xl border border-border bg-surface p-3.5",
        needs && "border-warning/40",
      )}
    >
      <View className="flex-row items-center gap-2">
        <Text numberOfLines={1} className="flex-1 text-[15px] font-semibold text-fg">
          {session.title}
        </Text>
        <AgentChip agent={session.agent} />
      </View>

      <View className="mt-1.5 flex-row items-center gap-1.5">
        <Text className="text-[11px] text-fg-faint">{session.host}</Text>
        {session.branch ? (
          <BranchChip branch={session.branch} worktree={session.worktree} className="max-w-[60%]" />
        ) : null}
        {!session.isLive ? (
          <Text className="rounded bg-surface-alt px-1.5 py-0.5 text-[10px] uppercase text-fg-faint">
            archived
          </Text>
        ) : null}
      </View>

      <View className="mt-2 flex-row items-center justify-between">
        <View className="flex-row items-center gap-1.5">
          <ActivityDot status={session.activity} />
          <Text
            className={cn(
              "text-[12px]",
              needs ? "text-warning" : session.activity === "failed" ? "text-danger" : "text-fg-faint",
            )}
          >
            {ACTIVITY_LABEL[session.activity]}
          </Text>
        </View>
        <Text className="text-[11px] text-fg-faint">{timeAgo(session.updatedAt)}</Text>
      </View>
    </Pressable>
  );
}
