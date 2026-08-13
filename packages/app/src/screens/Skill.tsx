/**
 * One skill, opened up — its facts, then the SKILL.md itself.
 *
 * The instructions ARE the skill, so the document is the page and everything
 * above it is a caption: what it's invoked as, which agents can see it, where
 * it came from and at which ref. That last one matters more than it looks —
 * a skill installed from a pinned tag behaves differently from the same name
 * pulled at HEAD, and nothing else in Pounce would tell you which you have.
 */
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useQuery } from "@tanstack/react-query";
import { useLocalSearchParams } from "expo-router";
import { fetchSkillDoc } from "../services/bridge";
import { AgentLogo, IS_DESKTOP } from "../ui";
import { agentLabel } from "../ui/tokens";
import { fmtBytes } from "../ui/format";
import { MessageMarkdown } from "../components/MessageMarkdown";
import { ActivitySkeleton } from "../components/Skeleton";

/**
 * The instructions, without the front matter.
 *
 * That `---` block is metadata, and every field in it is already a fact in the
 * card above. Left in, it renders as a horizontal rule followed by "name:" and
 * the description a second time — the document appears to open with a mistake.
 */
function body(doc: string): string {
  return doc.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trimStart();
}

/** "70d ago" — a skill nobody has touched in a year is worth noticing. */
function ago(iso: string | null): string | null {
  if (!iso) return null;
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  if (!Number.isFinite(days)) return null;
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return `${Math.round(days / 30)}mo ago`;
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={s.fact}>
      <Text style={s.factLabel}>{label}</Text>
      <View style={s.factValue}>{children}</View>
    </View>
  );
}

export default function SkillScreen() {
  const params = useLocalSearchParams<{
    hostId?: string;
    cwd?: string;
    dir?: string;
    name?: string;
  }>();
  const hostId = params.hostId ?? "";
  const cwd = params.cwd ?? "";
  const dir = params.dir ?? "";

  const q = useQuery({
    queryKey: ["skill", hostId, cwd, dir],
    queryFn: () => fetchSkillDoc(hostId, cwd, dir),
    enabled: !!(hostId && cwd && dir),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
  const skill = q.data;

  return (
    <ScrollView
      style={s.root}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={s.content}
    >
      {IS_DESKTOP ? <Text style={s.title}>{skill?.name ?? params.name ?? "Skill"}</Text> : null}

      {q.isPending ? (
        <ActivitySkeleton />
      ) : !skill ? (
        <View style={s.errorBox}>
          <Text style={s.errorTitle}>Couldn&apos;t read that skill</Text>
          <Text style={s.errorBody}>
            {dir
              ? "The machine no longer lists it for this project — it may have been removed or unlinked since the list was read."
              : "This skill is declared in skills-lock.json but isn't installed in this checkout, so there's no SKILL.md to read."}
          </Text>
        </View>
      ) : (
        <>
          {skill.description ? <Text style={s.lede}>{skill.description}</Text> : null}

          <View style={s.card}>
            <Fact label="Invoke">
              <Text style={s.mono}>/{skill.name}</Text>
            </Fact>
            <Fact label="Available">
              <Text style={s.factText}>
                {skill.scope === "project" ? "In this project" : "In every project"}
              </Text>
            </Fact>
            <Fact label="Agents">
              {skill.agents.length ? (
                <View style={s.agents}>
                  {skill.agents.map((a) => (
                    <View key={a} style={s.agentChip}>
                      <AgentLogo agent={a} size={12} />
                      <Text style={s.agentName}>{agentLabel(a)}</Text>
                    </View>
                  ))}
                </View>
              ) : (
                // Installed and wired to nothing: worth saying plainly, since
                // the skill looks present everywhere else you'd check.
                <Text style={s.factText}>No agent links this one — nothing can use it</Text>
              )}
            </Fact>
            {skill.source ? (
              <Fact label="Source">
                <Text style={s.factText}>
                  {skill.source.source}
                  {skill.source.ref ? ` · ${skill.source.ref}` : ""}
                </Text>
              </Fact>
            ) : null}
            <Fact label="Contents">
              <Text style={s.factText}>
                {skill.files
                  ? `${skill.files} supporting ${skill.files === 1 ? "file" : "files"} · `
                  : ""}
                {fmtBytes(skill.bytes)}
                {ago(skill.updatedAt) ? ` · updated ${ago(skill.updatedAt)}` : ""}
              </Text>
            </Fact>
            <Fact label="Path">
              <Text numberOfLines={2} style={s.path}>
                {skill.path}
              </Text>
            </Fact>
          </View>

          <Text style={s.docLabel}>SKILL.md</Text>
          <View style={s.doc}>
            {/* `singleBlock`: this is a document, not a chat turn — code blocks
                belong inline where the instructions put them, not lifted out
                into cards. */}
            <MessageMarkdown text={body(skill.doc)} role="assistant" singleBlock />
          </View>
        </>
      )}
    </ScrollView>
  );
}

const s = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.bg },
  content: { padding: 16, gap: 12, paddingBottom: 48 },
  title: { fontSize: 22, fontWeight: "700", color: theme.colors.fg },
  lede: { fontSize: 13, lineHeight: 19, color: theme.colors.fgMuted },
  card: {
    gap: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
    padding: 14,
  },
  fact: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  factLabel: { width: 78, fontSize: 11.5, color: theme.colors.fgFaint },
  factValue: { flex: 1 },
  factText: { fontSize: 12.5, color: theme.colors.fg },
  mono: { fontFamily: "JetBrainsMono", fontSize: 12.5, color: theme.colors.accent },
  path: { fontFamily: "JetBrainsMono", fontSize: 11, color: theme.colors.fgMuted },
  agents: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  agentChip: { flexDirection: "row", alignItems: "center", gap: 4 },
  agentName: { fontSize: 12, color: theme.colors.fg },
  docLabel: {
    marginTop: 6,
    fontSize: 11,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    color: theme.colors.fgFaint,
  },
  doc: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
    padding: 14,
  },
  errorBox: {
    gap: 6,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
    padding: 16,
  },
  errorTitle: { fontSize: 14, fontWeight: "600", color: theme.colors.fg },
  errorBody: { fontSize: 12.5, lineHeight: 18, color: theme.colors.fgMuted },
}));
