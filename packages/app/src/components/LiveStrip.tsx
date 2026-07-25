import { Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useRouter } from "expo-router";
import type { Session } from "@pounce/shared";
import { useLiveSessions, useProjectNames, useSessionsByLastActive } from "../state/db/hooks";
import { AgentStatusIcon } from "../ui";
import { GlassCard } from "../ui/native/GlassCard";

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
    <View style={s.root}>
      <Pressable
        onPress={() => router.push("/sessions")}
        style={({ pressed }) => [s.headerRow, pressed && s.pressed70]}
      >
        <View style={s.headerLeft}>
          {isLive ? <View style={s.liveDot} /> : null}
          <Text style={s.headerLabel}>{isLive ? `Live · ${live.length}` : "Recent"}</Text>
        </View>
        <Text style={s.seeAll}>See all →</Text>
      </Pressable>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 16, gap: 10 }}
      >
        {sessions.map((sn) => (
          <LiveCard
            key={sn.id}
            session={sn}
            repoName={repoNames[sn.repoId] ?? sn.repoId.replace(/^repo:/, "")}
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
      style={({ pressed }) => pressed && s.pressed70}
    >
      <GlassCard radius={14} style={[s.card, session.needsAttention && s.cardNeeds]}>
        <View style={s.cardIconRow}>
          {/* Never animates: this strip is a shortcut, not a status board. */}
          <AgentStatusIcon
            agent={session.agent}
            activity={session.activity}
            size={14}
            animated={false}
          />
        </View>
        {/* Reserve two lines so one- and two-line titles keep every card the same
          height and pin the repo name to a consistent baseline across the strip. */}
        <Text
          numberOfLines={2}
          style={[s.cardTitle, { minHeight: TITLE_LINE_HEIGHT * 2, lineHeight: TITLE_LINE_HEIGHT }]}
        >
          {session.title}
        </Text>
        <Text numberOfLines={1} style={s.cardRepo}>
          {repoName}
        </Text>
      </GlassCard>
    </Pressable>
  );
}

const s = StyleSheet.create((theme) => ({
  root: { paddingBottom: 4, paddingTop: 4 },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  headerLeft: { flexDirection: "row", alignItems: "center", gap: 6 },
  liveDot: { height: 6, width: 6, borderRadius: 999, backgroundColor: theme.colors.success },
  headerLabel: {
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    color: theme.colors.fgFaint,
  },
  seeAll: { fontSize: 12, color: theme.colors.fgMuted },
  card: {
    width: 150,
    padding: 12,
  },
  // warning at 40% — no soft-warning token in T; literal from the warning hex.
  cardNeeds: { borderWidth: 1, borderColor: "rgba(210, 153, 34, 0.4)" },
  cardIconRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  cardTitle: { marginTop: 8, fontSize: 13, fontWeight: "600", color: theme.colors.fg },
  cardRepo: { marginTop: 6, fontSize: 11, color: theme.colors.fgFaint },
  pressed70: { opacity: 0.7 },
}));
