import { useMemo, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useSelector } from "@legendapp/state/react";
import { Ionicons } from "@expo/vector-icons";
import type { AgentId } from "@litter/shared";
import {
  allDevices,
  capsFor,
  pendingTurns$,
  reposByActivity,
  sessions$,
  sessionsForRepo,
} from "@/state/stores";
import { Composer, type ComposerSubmit } from "@/components/Composer";
import { FolderBrowser } from "@/components/FolderBrowser";
import { AgentLogo, agentLabel, cn, COLOR } from "@/ui";
import { effectiveCaps } from "@/ui/agent-meta";

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
  const devices = useSelector(() => allDevices());
  const repos = useSelector(() => reposByActivity());

  const [hostId, setHostId] = useState<string | undefined>(devices[0]?.id);
  const [cwd, setCwd] = useState<string | null>(null);
  const [agent, setAgent] = useState<AgentId>("claude");
  const [browsing, setBrowsing] = useState(false);

  const reportedCaps = useSelector(() => capsFor(agent));
  const caps = effectiveCaps(agent, reportedCaps);

  const folderLabel = useMemo(() => (cwd ? cwd.split("/").pop() || cwd : null), [cwd]);

  // Quick-pick an existing repo: adopt its cwd + host so you land in a known dir.
  const pickRepo = (repoId: string) => {
    const s = sessionsForRepo(repoId).find((x) => x.cwd) ?? sessionsForRepo(repoId)[0];
    if (s?.cwd) setCwd(s.cwd);
    if (s?.hostId) setHostId(s.hostId);
  };
  const activeRepoId = repoIdForCwd(cwd);

  const launch = (s: ComposerSubmit) => {
    const id = `new_${Date.now()}`;
    const nowIso = new Date().toISOString();
    const device = devices.find((d) => d.id === hostId) ?? devices[0];
    sessions$[id].set({
      id,
      repoId: repoIdForCwd(cwd),
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
