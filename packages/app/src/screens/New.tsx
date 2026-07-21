import { useEffect, useMemo, useState } from "react";
import { KeyboardAvoidingView } from "../components/kav";
import {
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { PounceIcon } from "../ui/native/Icon";
import type { AgentId } from "@pounce/shared";
import {
  availAgentsForDevices,
  insertThread,
  markInteractive,
  pendingTurns$,
  reposByActivity,
  sortAgents,
} from "../state/stores";
import { useAgentCaps, useDevices, useProjects, useThreads } from "../state/db/hooks";
import { Composer, type ComposerSubmit } from "../components/Composer";
import { FolderBrowser } from "../components/FolderBrowser";
import { startInteractive } from "../services/bridge";
import { AgentLogo, agentLabel, IS_DESKTOP } from "../ui";
import { effectiveCaps } from "../ui/agent-meta";

// Fallback order when the selected device hasn't reported its agents yet
// (offline / first sync). Normally the picker shows the device's available set.
const DEFAULT_AGENTS: AgentId[] = ["claude", "codex", "cursor", "opencode"];

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
  const { theme } = useUnistyles();
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

  // The agent picker shows only agents the selected device reports as available
  // (installed + configured). Fall back to all devices' agents, then a default
  // order, so an offline/not-yet-synced device still offers a choice.
  const selectedDevice = useMemo(() => devices.find((d) => d.id === hostId), [devices, hostId]);
  const availAgents = useMemo<AgentId[]>(() => {
    const own = selectedDevice?.agents ?? [];
    if (own.length) return sortAgents(own) as AgentId[];
    const any = availAgentsForDevices(devices, null);
    return (any.length ? sortAgents(any) : DEFAULT_AGENTS) as AgentId[];
  }, [selectedDevice, devices]);

  // Keep the selection valid — if the chosen agent isn't available on this
  // device (e.g. after switching devices), fall back to the first available.
  useEffect(() => {
    if (availAgents.length && !availAgents.includes(agent)) setAgent(availAgents[0]);
  }, [availAgents, agent]);

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
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={[s.root, IS_DESKTOP ? { paddingTop: insets.top + 8 } : { paddingTop: 8 }]}
    >
      {/* Mobile shows the native modal navigation bar; this row is desktop chrome. */}
      {IS_DESKTOP ? (
        <View style={s.headerRow}>
          <Text style={s.headerTitle}>New task</Text>
          <Pressable onPress={() => router.back()} style={({ pressed }) => pressed && s.pressed60}>
            <Text style={s.cancelLabel}>Cancel</Text>
          </Pressable>
        </View>
      ) : null}

      <ScrollView style={s.scroll} contentContainerStyle={{ gap: 16, paddingBottom: 16 }}>
        {devices.length > 1 ? (
          <Field label="Device">
            <View style={s.chipRow}>
              {devices.map((d) => (
                <Chip key={d.id} active={hostId === d.id} onPress={() => setHostId(d.id)} label={d.name} />
              ))}
            </View>
          </Field>
        ) : null}

        <Field label="Folder">
          <Pressable
            onPress={() => setBrowsing(true)}
            style={({ pressed }) => [s.folderBtn, pressed && s.pressed80]}
          >
            <PounceIcon name="folder-outline" size={17} color={cwd ? theme.colors.accent : theme.colors.fgFaint} />
            <View style={s.flex1}>
              <Text numberOfLines={1} style={[s.folderLabel, cwd ? s.fgText : s.faintText]}>
                {folderLabel ?? "Choose a folder…"}
              </Text>
              {cwd ? (
                <Text numberOfLines={1} style={s.folderPath}>
                  {cwd}
                </Text>
              ) : null}
            </View>
            <PounceIcon name="chevron-forward" size={15} color={theme.colors.fgFaint} />
          </Pressable>

          {repos.length ? (
            <View style={[s.chipRow, s.mt2]}>
              {/* Quick-picks only — the 3 most recently active; the browser
                  above covers everything else. A selected repo outside the top
                  3 still shows so the choice stays visible. */}
              {repos
                .filter((r, i) => i < 3 || activeRepoId === r.id)
                .map((r) => (
                  <Chip key={r.id} active={activeRepoId === r.id} onPress={() => pickRepo(r.id)} label={r.name} />
                ))}
            </View>
          ) : null}
        </Field>

        <Field label="Agent">
          <View style={s.chipRow}>
            {availAgents.map((a) => (
              <Pressable
                key={a}
                onPress={() => setAgent(a)}
                style={[s.agentPill, agent === a ? s.pillActive : s.pillIdle]}
              >
                <AgentLogo agent={a} size={14} />
                <Text style={[s.pillText, agent === a ? s.accentText : s.mutedText]}>
                  {agentLabel(a)}
                </Text>
              </Pressable>
            ))}
          </View>
        </Field>
      </ScrollView>

      {/* Same composer as the session view — mode / effort / image / slash */}
      <View style={[s.footer, { paddingBottom: insets.bottom + 8 }]}>
        {agent === "claude" ? (
          <Pressable
            onPress={() => setInteractive((v) => !v)}
            style={({ pressed }) => [
              s.interactiveBtn,
              interactive ? s.interactiveActive : s.interactiveIdle,
              pressed && s.pressed80,
            ]}
          >
            <PounceIcon
              name={interactive ? "flash" : "flash-outline"}
              size={13}
              color={interactive ? theme.colors.accent : theme.colors.fgMuted}
            />
            <Text style={[s.interactiveText, interactive ? s.accentText : s.mutedText]}>
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
    <View style={s.field}>
      <Text style={s.fieldLabel}>{label}</Text>
      {children}
    </View>
  );
}

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[s.chip, active ? s.pillActive : s.pillIdle]}>
      <Text style={[s.pillText, active ? s.accentText : s.mutedText]}>{label}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.bg },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  headerTitle: { fontSize: 22, fontWeight: "700", color: theme.colors.fg },
  cancelLabel: { fontSize: 15, color: theme.colors.fgMuted },
  pressed60: { opacity: 0.6 },
  pressed80: { opacity: 0.8 },
  scroll: { flex: 1, paddingHorizontal: 16 },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  mt2: { marginTop: 8 },
  folderBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  flex1: { flex: 1 },
  folderLabel: { fontSize: 14 },
  fgText: { color: theme.colors.fg },
  faintText: { color: theme.colors.fgFaint },
  folderPath: { fontFamily: "JetBrainsMono", fontSize: 11, color: theme.colors.fgFaint },
  agentPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  pillActive: { borderColor: theme.colors.accent, backgroundColor: theme.colors.accentSoft },
  pillIdle: { borderColor: theme.colors.border, backgroundColor: theme.colors.surface },
  pillText: { fontSize: 13 },
  accentText: { color: theme.colors.accent },
  mutedText: { color: theme.colors.fgMuted },
  // Transparent, borderless bar — the Composer's floating glass pill carries
  // its own margins and chrome now.
  footer: {
    paddingTop: 8,
  },
  interactiveBtn: {
    height: 28,
    marginHorizontal: 12,
    marginBottom: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    alignSelf: "flex-start",
    borderRadius: 999,
    paddingHorizontal: 12,
  },
  interactiveActive: { backgroundColor: theme.colors.accentSoft },
  interactiveIdle: { backgroundColor: theme.colors.surfaceAlt },
  interactiveText: { fontSize: 12 },
  field: { gap: 8 },
  fieldLabel: { fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5, color: theme.colors.fgFaint },
  chip: { borderRadius: 999, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 6 },
}));
