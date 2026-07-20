import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import type { Session } from "@pounce/shared";
import { ACTIVITY_LABEL, AgentChip, BranchChip, timeAgo } from "../ui";
import { GlassCard } from "../ui/native/GlassCard";
import { T } from "../ui/theme";

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
      style={({ pressed }) => pressed && s.pressed70}
    >
      <GlassCard radius={16} style={[s.card, needs && s.cardNeeds]}>
      <View style={s.titleRow}>
        <Text
          numberOfLines={1}
          style={[s.title, session.activity === "idle" ? s.titleIdle : s.titleFg]}
        >
          {session.title}
        </Text>
        <AgentChip agent={session.agent} activity={session.activity} />
      </View>

      <View style={s.metaRow}>
        <Text style={s.metaText}>{session.host}</Text>
        {session.branch ? (
          <BranchChip branch={session.branch} worktree={session.worktree} style={s.branch} />
        ) : null}
        {!session.isLive ? (
          <Text style={s.archived}>
            archived
          </Text>
        ) : null}
      </View>

      <View style={s.footerRow}>
        <Text
          style={[
            s.status,
            needs ? s.statusWarning : session.activity === "failed" ? s.statusDanger : s.statusFaint,
          ]}
        >
          {ACTIVITY_LABEL[session.activity]}
        </Text>
        <Text style={s.metaText}>{timeAgo(session.updatedAt)}</Text>
      </View>
      </GlassCard>
    </Pressable>
  );
}

const s = StyleSheet.create({
  card: {
    padding: 14,
  },
  // warning at 40% — no soft-warning token in T; literal from the warning hex.
  cardNeeds: { borderWidth: 1, borderColor: "rgba(210, 153, 34, 0.4)" },
  pressed70: { opacity: 0.7 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { flex: 1, fontSize: 15, fontWeight: "600" },
  titleIdle: { color: T.fgMuted },
  titleFg: { color: T.fg },
  metaRow: { marginTop: 6, flexDirection: "row", alignItems: "center", gap: 6 },
  metaText: { fontSize: 11, color: T.fgFaint },
  branch: { maxWidth: "60%" },
  archived: {
    borderRadius: 4,
    backgroundColor: T.surfaceAlt,
    paddingHorizontal: 6,
    paddingVertical: 2,
    fontSize: 10,
    textTransform: "uppercase",
    color: T.fgFaint,
  },
  footerRow: { marginTop: 8, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  status: { fontSize: 12 },
  statusWarning: { color: T.warning },
  statusDanger: { color: T.danger },
  statusFaint: { color: T.fgFaint },
});
