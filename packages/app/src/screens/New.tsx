import { useEffect, useMemo, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import type { AgentId } from "@pounce/shared";
import { insertThread, markInteractive, pendingTurns$, reposByActivity } from "../state/stores";
import { useAgentCaps, useDevices, useProjects, useThreads } from "../state/db/hooks";
import { Composer, type ComposerSubmit } from "../components/Composer";
import { FolderBrowser } from "../components/FolderBrowser";
import { startInteractive } from "../services/bridge";
import { AgentLogo, agentLabel, cn, COLOR } from "../ui";
import { effectiveCaps } from "../ui/agent-meta";

const AGENTS: AgentId[] = ["claude", "codex", "opencode"];

/** Repo key from an absolute path — mirrors the bridge's `repoInfo` basename. */
function repoIdForCwd(cwd: string | null): string {
  if (!cwd) return "repo:Scratch";
  const base = cwd.replace(/\/+$/, "").split("/").pop() || "Scratch";
  return `repo:${base}`;
}

/** Start a new task: pick device + folder + agent, then compose. */
export default function NewTaskScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { repoId } = useLocalSearchParams<{ repoId?: string }>();
  const devices = useDevices();
  const rawThreads = useThreads();
  const projectList = useProjects();
  const repos = useMemo(
    () => reposByActivity(projectList, rawThreads, { device: null, agent: null }),
    [projectList, rawThreads],
  );

  // Default to a REACHABLE device — a stale/dead pairing (e.g. an old IP) can
  // otherwise sit at devices[0] and silently swallow the turn (no response).
  const [hostId, setHostId] = useState<string | undefined>(
    (devices.find((d) => d.online) ?? devices[0])?.id,
  );
  const [cwd, setCwd] = useState<string | null>(null);
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null);
  const [agent, setAgent] = useState<AgentId>("claude");
  const [browsing, setBrowsing] = useState(false);
  // Interactive = the bridge hosts claude's real TUI in a PTY, so its prompts
  // (AskUserQuestion, …) are answerable from the app. Claude-only for now.
  const [interactive, setInteractive] = useState(false);

  const reportedCaps = useAgentCaps(agent);
  const caps = effectiveCaps(agent, reportedCaps);

  const folderLabel = useMemo(() => (cwd ? cwd.split("/").pop() || cwd : null), [cwd]);

  // Quick-pick an existing repo: adopt its working dir + host so you land in a
  // known dir. Prefer a non-worktree session so a new task starts in the repo
  // root rather than some worktree. Remember the folder explicitly — since the
  // bridge folds worktrees into their origin repo, repoId no longer equals the
  // cwd basename, so it can't be re-derived from cwd.
  const pickRepo = (rid: string) => {
    const list = rawThreads
      .filter((x) => x.repoId === rid)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    const s = list.find((x) => x.cwd && !x.worktree) ?? list.find((x) => x.cwd) ?? list[0];
    setSelectedRepoId(rid);
    if (s?.cwd) setCwd(s.cwd);
    if (s?.hostId) setHostId(s.hostId);
  };
  const activeRepoId = selectedRepoId ?? repoIdForCwd(cwd);

  // Backfill the host once devices load (they may be empty on first mount), and
  // only while nothing is selected yet — never override a user/folder choice.
  useEffect(() => {
    if (!hostId && devices.length) setHostId((devices.find((d) => d.online) ?? devices[0])?.id);
  }, [hostId, devices]);

  // Seeded from a folder's "+" on Home: adopt that repo's cwd + device on mount
  // so the user lands straight on the composer for that folder.
  useEffect(() => {
    if (repoId) pickRepo(repoId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoId]);

  const launch = async (s: ComposerSubmit) => {
    const nowIso = new Date().toISOString();
    const device = devices.find((d) => d.id === hostId) ?? devices[0];

    // Interactive: the bridge spawns claude's TUI in a PTY now and returns the
    // real threadId — open it directly (no pending headless turn). Its questions
    // then surface as answerable cards. Falls through to the normal path on error.
    if (interactive && agent === "claude" && device) {
      const realId = await startInteractive(device.id, s.text, cwd);
      if (realId) {
        // Route this thread's future follow-ups back through the interactive
        // path so they reuse/resume this one session (answerable prompts) rather
        // than spawning fresh sessions — see isThreadInteractive in Session.
        markInteractive(realId);
        insertThread({
          id: realId,
          repoId: selectedRepoId ?? repoIdForCwd(cwd),
          hostId: device.id,
          host: device.name,
          agent,
          title: s.text.slice(0, 100) || "New task",
          branch: null,
          worktree: null,
          cwd,
          isLive: true,
          activity: "running",
          needsAttention: false,
          createdAt: nowIso,
          updatedAt: nowIso,
        });
        router.replace(`/session/${realId}`);
        return;
      }
    }

    const id = `new_${Date.now()}`;
    insertThread({
      id,
      repoId: selectedRepoId ?? repoIdForCwd(cwd),
      hostId: device?.id ?? "dev:local",
      host: device?.name ?? "local",
      agent,
      title: s.text.slice(0, 100) || "New task",
      branch: null,
      worktree: null,
      cwd,
      isLive: true,
      activity: "queued",
      needsAttention: false,
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    // Hand the first turn (prompt + mode/effort/images) to the session screen.
    pendingTurns$[id].set(s);
    router.replace(`/session/${id}`);
  };

  return (
    <KeyboardAvoidingView
      className="flex-1 bg-bg"
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={{ paddingTop: insets.top + 8 }}
    >
      <View className="flex-row items-center justify-between px-4 pb-3">
        <Text className="text-[22px] font-bold text-fg">New task</Text>
        <Pressable onPress={() => router.back()} className="active:opacity-60">
          <Text className="text-[15px] text-fg-muted">Cancel</Text>
        </Pressable>
      </View>

      <ScrollView className="flex-1 px-4" contentContainerStyle={{ gap: 16, paddingBottom: 16 }}>
        {devices.length > 1 ? (
          <Field label="Device">
            <View className="flex-row flex-wrap gap-2">
              {devices.map((d) => (
                <Chip key={d.id} active={hostId === d.id} onPress={() => setHostId(d.id)} label={d.name} />
              ))}
            </View>
          </Field>
        ) : null}

        <Field label="Folder">
          <Pressable
            onPress={() => setBrowsing(true)}
            className="active:opacity-80 flex-row items-center gap-2 rounded-xl border border-border bg-surface px-3.5 py-3"
          >
            <Ionicons name="folder-outline" size={17} color={cwd ? COLOR.accent : COLOR.fgFaint} />
            <View className="flex-1">
              <Text numberOfLines={1} className={cn("text-[14px]", cwd ? "text-fg" : "text-fg-faint")}>
                {folderLabel ?? "Choose a folder…"}
              </Text>
              {cwd ? (
                <Text numberOfLines={1} className="font-mono text-[11px] text-fg-faint">
                  {cwd}
                </Text>
              ) : null}
            </View>
            <Ionicons name="chevron-forward" size={15} color={COLOR.fgFaint} />
          </Pressable>

          {repos.length ? (
            <View className="mt-2 flex-row flex-wrap gap-2">
              {repos.map((r) => (
                <Chip key={r.id} active={activeRepoId === r.id} onPress={() => pickRepo(r.id)} label={r.name} />
              ))}
            </View>
          ) : null}
        </Field>

        <Field label="Agent">
          <View className="flex-row flex-wrap gap-2">
            {AGENTS.map((a) => (
              <Pressable
                key={a}
                onPress={() => setAgent(a)}
                className={cn(
                  "flex-row items-center gap-1.5 rounded-full border px-3 py-1.5",
                  agent === a ? "border-accent bg-accent-soft" : "border-border bg-surface",
                )}
              >
                <AgentLogo agent={a} size={14} />
                <Text className={cn("text-[13px]", agent === a ? "text-accent" : "text-fg-muted")}>
                  {agentLabel(a)}
                </Text>
              </Pressable>
            ))}
          </View>
        </Field>
      </ScrollView>

      {/* Same composer as the session view — mode / effort / image / slash */}
      <View style={{ paddingBottom: insets.bottom + 8 }} className="border-t border-border bg-bg-elevated px-3 pt-2">
        {agent === "claude" ? (
          <Pressable
            onPress={() => setInteractive((v) => !v)}
            className={cn(
              "active:opacity-80 mb-2 flex-row items-center gap-1.5 self-start rounded-full border px-3 py-1.5",
              interactive ? "border-accent bg-accent-soft" : "border-border bg-surface",
            )}
          >
            <Ionicons
              name={interactive ? "flash" : "flash-outline"}
              size={13}
              color={interactive ? COLOR.accent : COLOR.fgMuted}
            />
            <Text className={cn("text-[12px]", interactive ? "text-accent" : "text-fg-muted")}>
              Interactive{interactive ? " · answerable prompts" : ""}
            </Text>
          </Pressable>
        ) : null}
        <Composer
          agent={agent}
          caps={caps}
          hostId={hostId}
          cwd={cwd}
          placeholder="Describe the task… e.g. Add idempotent retry to the webhook handler"
          onSubmit={launch}
        />
      </View>

      <FolderBrowser
        hostId={hostId}
        visible={browsing}
        initialPath={cwd}
        onClose={() => setBrowsing(false)}
        onPick={(p) => {
          setCwd(p);
          setSelectedRepoId(repoIdForCwd(p));
          setBrowsing(false);
        }}
      />
    </KeyboardAvoidingView>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View className="gap-2">
      <Text className="text-[12px] uppercase tracking-wide text-fg-faint">{label}</Text>
      {children}
    </View>
  );
}

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} className={cn("rounded-full border px-3.5 py-1.5", active ? "border-accent bg-accent-soft" : "border-border bg-surface")}>
      <Text className={cn("text-[13px]", active ? "text-accent" : "text-fg-muted")}>{label}</Text>
    </Pressable>
  );
}
