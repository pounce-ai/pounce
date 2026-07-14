import { Pressable, ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import type { Session } from "@litter/shared";
import { useProjectNames, useRecentSessions } from "../state/db/hooks";
import { AgentStatusIcon, cn } from "../ui";

const MAX_RECENT = 8;
/** Title line height (px). Two lines are reserved so one- and two-line titles
 *  keep every card the same height — derived, so the two stay in lockstep. */
const TITLE_LINE_HEIGHT = 17;

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
        {/* Never animates: this strip is a shortcut, not a status board. */}
        <AgentStatusIcon agent={session.agent} activity={session.activity} size={14} animated={false} />
      </View>
      {/* Reserve two lines so one- and two-line titles keep every card the same
          height and pin the repo name to a consistent baseline across the strip. */}
      <Text
        numberOfLines={2}
        style={{ minHeight: TITLE_LINE_HEIGHT * 2, lineHeight: TITLE_LINE_HEIGHT }}
        className="mt-2 text-[13px] font-semibold text-fg"
      >
        {session.title}
      </Text>
      <Text numberOfLines={1} className="mt-1.5 text-[11px] text-fg-faint">
        {repoName}
      </Text>
    </Pressable>
  );
}
