import { Pressable, ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import type { Session } from "@pounce/shared";
import { useLiveSessions, useProjectNames, useSessionsByLastActive } from "../state/db/hooks";
import { AgentStatusIcon, cn } from "../ui";

/** How many fallback (most-recently-active) cards to show when nothing is live. */
const FALLBACK_COUNT = 5;
/** Cap the live strip so it stays a strip — the full list is behind "See all". */
const MAX_LIVE = 12;
/** Title line height (px). Two lines are reserved so one- and two-line titles
 *  keep every card the same height — derived, so the two stay in lockstep. */
const TITLE_LINE_HEIGHT = 17;

/**
 * "Live" — a horizontal strip of the sessions whose agent is working right now
 * (running/streaming), most-recent activity first. When nothing is live it falls
 * back to the last few sessions by activity ("Recent") so there's always
 * somewhere to jump back into. The header opens the full activity-ordered list.
 * Hidden only when there are no sessions at all.
 */
export function LiveStrip() {
  const router = useRouter();
  const live = useLiveSessions();
  const fallback = useSessionsByLastActive(FALLBACK_COUNT);
  const repoNames = useProjectNames();
  const isLive = live.length > 0;
  const sessions = isLive ? live.slice(0, MAX_LIVE) : fallback;
  if (sessions.length === 0) return null;
  return (
    <View className="pb-1 pt-1">
      <Pressable
        onPress={() => router.push("/sessions")}
        className="active:opacity-70 flex-row items-center justify-between px-4 pb-2"
      >
        <View className="flex-row items-center gap-1.5">
          {isLive ? <View className="h-1.5 w-1.5 rounded-full bg-success" /> : null}
          <Text className="text-[12px] uppercase tracking-wide text-fg-faint">
            {isLive ? `Live · ${live.length}` : "Recent"}
          </Text>
        </View>
        <Text className="text-[12px] text-fg-muted">See all →</Text>
      </Pressable>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 16, gap: 10 }}
      >
        {sessions.map((s) => (
          <LiveCard
            key={s.id}
            session={s}
            repoName={repoNames[s.repoId] ?? s.repoId.replace(/^repo:/, "")}
          />
        ))}
      </ScrollView>
    </View>
  );
}

function LiveCard({ session, repoName }: { session: Session; repoName: string }) {
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
