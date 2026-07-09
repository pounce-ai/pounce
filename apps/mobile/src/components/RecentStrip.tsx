import { Pressable, ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import type { Session } from "@litter/shared";
import { useProjectNames, useRecentSessions } from "@/state/db/hooks";
import { ActivityDot, AgentLogo, cn } from "@/ui";

const MAX_RECENT = 8;

/**
 * "Jump back in" — a horizontal strip of the threads the user opened most
 * recently. Ordering comes from user visits, not agent activity, so it stays
 * put unless *you* revisit something. Hidden when empty.
 */
export function RecentStrip() {
  const recents = useRecentSessions(MAX_RECENT);
  const repoNames = useProjectNames();
  if (recents.length === 0) return null;
  return (
    <View className="pb-1 pt-1">
      <Text className="px-4 pb-2 text-[12px] uppercase tracking-wide text-fg-faint">
        Jump back in
      </Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 16, gap: 10 }}
      >
        {recents.map((s) => (
          <RecentCard
            key={s.id}
            session={s}
            repoName={repoNames[s.repoId] ?? s.repoId.replace(/^repo:/, "")}
          />
        ))}
      </ScrollView>
    </View>
  );
}

function RecentCard({ session, repoName }: { session: Session; repoName: string }) {
  const router = useRouter();
  return (
    <Pressable
      onPress={() => router.push(`/session/${session.id}`)}
      className={cn(
        "active:bg-surface-hover w-[150px] rounded-2xl border border-border bg-surface p-3",
        session.needsAttention && "border-warning/40",
      )}
    >
      <View className="flex-row items-center gap-1.5">
        <ActivityDot status={session.activity} size={7} />
        <AgentLogo agent={session.agent} size={13} />
      </View>
      <Text numberOfLines={2} className="mt-2 text-[13px] font-semibold leading-[17px] text-fg">
        {session.title}
      </Text>
      <Text numberOfLines={1} className="mt-1.5 text-[11px] text-fg-faint">
        {repoName}
      </Text>
    </Pressable>
  );
}
