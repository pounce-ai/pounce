/**
 * The skills an agent working in this project can reach.
 *
 * Skills decide what an agent will actually do in a repo, and they were
 * invisible from Pounce: you could read every transcript one produced and never
 * see the skill that shaped it. This lists them the way skills.sh stores them —
 * so it isn't one agent's view — and says, per row, which agents can see it.
 *
 * Two states are worth as much as the list itself:
 *   • installed but linked by NO agent — present on disk, wired to nothing.
 *   • declared in `skills-lock.json` and not installed — what a fresh worktree
 *     looks like, and the answer to "why is it ignoring my skill".
 */
import { useMemo } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { type SkillRow, fetchSkills } from "../services/bridge";
import { AgentLogo, IS_DESKTOP } from "../ui";
import { PounceIcon } from "../ui/native/Icon";

/** "asc-cli-usage" is invoked as "/asc-cli-usage" — worth showing, because the
 *  name alone doesn't say it's a thing you can type. */
const invoke = (s: SkillRow) => `/${s.name}`;

function SkillItem({ skill, onPress }: { skill: SkillRow; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={!skill.installed}
      style={({ pressed }) => [s.row, pressed && skill.installed && s.pressed]}
    >
      <View style={s.rowHead}>
        <Text numberOfLines={1} style={[s.name, !skill.installed && s.nameOff]}>
          {skill.name}
        </Text>
        {skill.scope === "project" ? <Text style={s.badge}>project</Text> : null}
        {!skill.installed ? <Text style={s.badgeWarn}>not installed</Text> : null}
        {skill.installed && !skill.agents.length ? (
          <Text style={s.badgeWarn}>no agent linked</Text>
        ) : null}
        {/* Who can actually use it. The logos ARE the answer to "is this a
            Claude thing or an everything thing". */}
        <View style={s.agents}>
          {skill.agents.map((a) => (
            <AgentLogo key={a} agent={a} size={12} />
          ))}
        </View>
        {skill.installed ? <PounceIcon name="chevron-forward" size={12} color="#8a8a8e" /> : null}
      </View>
      <Text numberOfLines={2} style={s.desc}>
        {skill.description ||
          (skill.installed
            ? "No description in its front matter."
            : `Declared in skills-lock.json${
                skill.source ? ` from ${skill.source.source}` : ""
              }, but not installed in this checkout.`)}
      </Text>
    </Pressable>
  );
}

export function SkillsCard({ hostId, cwd }: { hostId: string; cwd: string }) {
  const router = useRouter();
  const q = useQuery({
    queryKey: ["skills", hostId, cwd],
    queryFn: () => fetchSkills(hostId, cwd),
    // A skill changes when someone installs or edits one, not while you read.
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  const { project, user, missing } = useMemo(() => {
    const all = q.data?.skills ?? [];
    return {
      project: all.filter((x) => x.scope === "project" && x.installed),
      user: all.filter((x) => x.scope === "user" && x.installed),
      missing: all.filter((x) => !x.installed),
    };
  }, [q.data]);

  const open = (skill: SkillRow) =>
    router.push({
      pathname: "/skill",
      params: { hostId, cwd, dir: skill.path ?? "", name: skill.name },
    });

  const total = project.length + user.length;
  return (
    <View style={s.section}>
      <View style={s.head}>
        <Text style={s.title}>Skills</Text>
        {q.isPending ? <ActivityIndicator size="small" /> : null}
      </View>
      <Text style={s.note}>
        {q.isPending
          ? "Reading this project's skills…"
          : q.data === null
            ? "That machine didn't answer."
            : total === 0 && !missing.length
              ? "No skills reach this project — nothing in its store, and nothing in yours."
              : `${total} available here${
                  missing.length ? ` · ${missing.length} declared but not installed` : ""
                }. Read the way skills.sh stores them, so every agent's are listed.`}
      </Text>

      {project.length ? (
        <View style={s.card}>
          {project.map((skill) => (
            <SkillItem key={skill.path ?? skill.name} skill={skill} onPress={() => open(skill)} />
          ))}
        </View>
      ) : null}

      {/* The user's own skills come second: they apply everywhere, so they say
          less about THIS project than the ones checked in beside it. */}
      {user.length ? (
        <>
          <Text style={s.subhead}>Available in every project</Text>
          <View style={s.card}>
            {user.map((skill) => (
              <SkillItem key={skill.path ?? skill.name} skill={skill} onPress={() => open(skill)} />
            ))}
          </View>
        </>
      ) : null}

      {missing.length ? (
        <>
          <Text style={s.subhead}>Declared, not installed</Text>
          <View style={s.card}>
            {missing.map((skill) => (
              <SkillItem key={skill.name} skill={skill} onPress={() => open(skill)} />
            ))}
          </View>
        </>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create((theme) => ({
  section: { gap: 8, marginTop: IS_DESKTOP ? 20 : 16 },
  head: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: {
    fontSize: 11,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    color: theme.colors.fgFaint,
  },
  note: { fontSize: 11.5, lineHeight: 16, color: theme.colors.fgFaint },
  subhead: { marginTop: 6, fontSize: 11.5, color: theme.colors.fgFaint },
  card: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
    paddingHorizontal: 14,
    paddingVertical: 4,
  },
  // Divided, not spaced — the same rule the worktree list follows, so a long
  // list reads as rows rather than one wall.
  row: {
    gap: 3,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
  },
  pressed: { opacity: 0.7 },
  rowHead: { flexDirection: "row", alignItems: "center", gap: 6 },
  name: { flexShrink: 1, fontSize: 13, fontWeight: "500", color: theme.colors.fg },
  nameOff: { color: theme.colors.fgMuted },
  desc: { fontSize: 11.5, lineHeight: 16, color: theme.colors.fgFaint },
  agents: { flexDirection: "row", alignItems: "center", gap: 4, marginLeft: "auto" },
  badge: {
    borderRadius: 999,
    backgroundColor: theme.colors.accentSoft,
    paddingHorizontal: 7,
    paddingVertical: 1,
    fontSize: 10,
    fontWeight: "600",
    color: theme.colors.accent,
  },
  badgeWarn: {
    borderRadius: 999,
    backgroundColor: theme.colors.warningSoft,
    paddingHorizontal: 7,
    paddingVertical: 1,
    fontSize: 10,
    fontWeight: "600",
    color: theme.colors.warning,
  },
}));

export { invoke as skillInvocation };
