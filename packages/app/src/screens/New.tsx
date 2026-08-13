import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useLocalSearchParams, useRouter } from "expo-router";
import { PounceIcon } from "../ui/native/Icon";
import type { AgentId } from "@pounce/shared";
import {
  availAgentsForDevices,
  insertThread,
  markInteractive,
  pendingTurns$,
  reposByActivity,
  setThreadModel,
  sortAgents,
} from "../state/stores";
import { useAgentCaps, useDevices, useProjects, useThreads } from "../state/db/hooks";
import { ChatKeyboardSticky } from "../components/ChatList";
import { Composer, type ComposerHandle, type ComposerSubmit } from "../components/Composer";
import { FolderBrowser } from "../components/FolderBrowser";
import { ModelSheet } from "../components/ModelSheet";
import { shortModel } from "../components/ThreadStatusBar";
import { ConnectFlow } from "../components/ConnectFlow";
import { contextDraft$ } from "../state/contextComments";
import { drafts$, ensureDraft, nextDraftId, removeDraft, updateDraft } from "../state/drafts";
import { startInteractive } from "../services/bridge";
import { agentLabel } from "../ui";
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
  const router = useRouter();
  const { theme } = useUnistyles();
  // `cwd`/`hostId` seed an exact folder (from the Project context screen);
  // `repoId` alone seeds the repo and lets pickRepo choose the folder.
  const {
    repoId,
    cwd: cwdParam,
    hostId: hostParam,
    draft: draftParam,
  } = useLocalSearchParams<{
    repoId?: string;
    cwd?: string;
    hostId?: string;
    draft?: string;
  }>();
  // Resuming a parked task: the draft's own answers outrank the route's seeds,
  // since they are what the user last chose.
  const resumed = draftParam ? drafts$[String(draftParam)].peek() : undefined;
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
    resumed?.hostId ??
      (hostParam ? String(hostParam) : (devices.find((d) => d.online) ?? devices[0])?.id),
  );
  const [cwd, setCwd] = useState<string | null>(
    resumed?.cwd ?? (cwdParam ? String(cwdParam) : null),
  );
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(resumed?.repoId ?? null);
  const [agent, setAgent] = useState<AgentId>(resumed?.agent ?? "claude");
  /** null = the agent's own default, which is what the pill says until you
   *  choose. Restored with the agent, since the two are one decision. */
  const [model, setModel] = useState<string | null>(resumed?.model ?? null);
  const [modelSheet, setModelSheet] = useState(false);
  /**
   * Did whoever opened this screen already answer "where"?
   *
   * From a Space or a folder row's "+", the folder and the machine are decided
   * before you arrive — the space IS a repo on a host — so asking again is
   * three controls of chrome between you and the prompt. Only the global "+"
   * has a real question to ask.
   *
   * A RESUMED draft counts: one carrying a folder was started somewhere that
   * knew it, and re-asking on resume would undo the point. Read once at mount
   * (from the params/draft, not from live state) so picking a folder in the
   * unseeded case doesn't make the picker vanish under your finger.
   */
  const [seeded] = useState(() => !!(cwdParam || repoId || resumed?.cwd || resumed?.repoId));
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

  /** Switching agent drops the model: model ids belong to one agent, and
   *  carrying "opus-5" over to Codex would ask for something that isn't there.
   *  Cleared rather than remapped — the sheet re-lists, and the daemon's own
   *  default is the honest starting point for the new agent. */
  const pickAgent = (a: AgentId) => {
    setAgent(a);
    setModel(null);
  };

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
  // so the user lands straight on the composer for that folder. An explicit
  // cwd param (from Project context) already names the exact folder — pickRepo
  // would second-guess it and could pick a different worktree.
  useEffect(() => {
    if (cwdParam) {
      if (repoId) setSelectedRepoId(String(repoId));
      return;
    }
    if (repoId) pickRepo(repoId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoId, cwdParam]);

  // A queued change request from the Project context screen. One-shot: read it,
  // clear it, drop it into the composer as an ordinary editable draft — the
  // user still gets to reword before sending.
  const composerRef = useRef<ComposerHandle>(null);
  useEffect(() => {
    const draft = contextDraft$.peek();
    if (!draft) return;
    contextDraft$.set(null);
    composerRef.current?.insert(draft);
  }, []);

  /**
   * This visit's draft, created on open so nothing typed is ever lost.
   *
   * An empty one is never LISTED (see listDrafts), so opening the screen and
   * changing your mind leaves no trace — but the moment there is a prompt or a
   * folder, closing the screen parks the task instead of discarding it.
   */
  const [draftId] = useState(() => resumed?.id ?? nextDraftId());
  // The WRITE happens here, not in render. `useRef(newDraft().id)` used to do
  // both — and because useRef evaluates its argument every render, it minted a
  // fresh throwaway draft each time and mutated the store mid-render, which
  // React flags the moment any other screen subscribes to drafts (Home now
  // does, for its Drafts shelf).
  useEffect(() => {
    ensureDraft(draftId);
  }, [draftId]);
  useEffect(() => {
    if (resumed?.text) composerRef.current?.insert(resumed.text);
    // Once, on mount: re-inserting on every change would fight the input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Every choice is part of the parked task, not just the words.
  useEffect(() => {
    updateDraft(draftId, { hostId: hostId ?? null, cwd, repoId: selectedRepoId, agent, model });
  }, [draftId, hostId, cwd, selectedRepoId, agent, model]);

  const launch = async (s: ComposerSubmit) => {
    const nowIso = new Date().toISOString();
    const device = devices.find((d) => d.id === hostId) ?? devices[0];

    // Interactive: the bridge spawns claude's TUI in a PTY now and returns the
    // real threadId — open it directly (no pending headless turn). Its questions
    // then surface as answerable cards. Falls through to the normal path on error.
    if (interactive && agent === "claude" && device) {
      // The PTY is spawned once and keeps its model, so it has to be told here
      // — there is no later turn to carry it.
      const realId = await startInteractive(device.id, s.text, cwd, undefined, model);
      if (realId) {
        // Route this thread's future follow-ups back through the interactive
        // path so they reuse/resume this one session (answerable prompts) rather
        // than spawning fresh sessions — see isThreadInteractive in Session.
        markInteractive(realId);
        // The chosen model, against the id this thread will keep.
        if (model) setThreadModel(realId, model);
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
          isResumable: true,
          activity: "running",
          needsAttention: false,
          createdAt: nowIso,
          updatedAt: nowIso,
        });
        removeDraft(draftId);
        router.replace(`/session/${realId}`);
        return;
      }
    }

    // No machine, no task. The old fallback invented `dev:local` and inserted a
    // thread that could never run — a phantom session in the list forever.
    if (!device) return;

    const id = `new_${Date.now()}`;
    insertThread({
      id,
      repoId: selectedRepoId ?? repoIdForCwd(cwd),
      hostId: device.id,
      host: device.name,
      agent,
      title: s.text.slice(0, 100) || "New task",
      branch: null,
      worktree: null,
      cwd,
      isResumable: true,
      activity: "queued",
      needsAttention: false,
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    // The model goes BOTH ways on purpose. The store is what every later turn
    // reads, and `rekeyThread` carries it across the new_ -> real id swap; the
    // turn carries it too because the store write isn't readable yet when the
    // session screen fires this first turn (see PendingTurn.model).
    if (model) setThreadModel(id, model);
    // Hand the first turn (prompt + mode/effort/images) to the session screen.
    pendingTurns$[id].set({ ...s, model });
    removeDraft(draftId);
    router.replace(`/session/${id}`);
  };

  // Reachable by deep link and from Space even when Home hides its + button.
  // A folder picker, an agent list and a composer are all meaningless with
  // nowhere to run — offer the one thing that changes that.
  if (!devices.length) {
    return (
      <View style={[s.root, { paddingTop: 8 }]}>
        <ScrollView style={s.scroll} contentContainerStyle={{ gap: 16, paddingBottom: 16 }}>
          <Text style={s.emptyTitle}>Nothing to run this on</Text>
          <ConnectFlow />
        </ScrollView>
      </View>
    );
  }

  return (
    // NOT a KeyboardAvoidingView. This screen is a modal WITH a native header,
    // and a KAV measures its own frame against the window: the header and the
    // sheet's top inset are missing from that sum, so it lifted the composer
    // ~85pt short and the keyboard covered the send button. The composer rides
    // the keyboard directly instead — the same UI-thread sticky view Session
    // uses, which has no offset to get wrong.
    <View style={[s.root, s.rootPad]}>
      <ScrollView style={s.scroll} contentContainerStyle={{ gap: 16, paddingBottom: 16 }}>
        {devices.length > 1 && !seeded ? (
          <Field label="Device">
            <View style={s.chipRow}>
              {devices.map((d) => (
                <Chip
                  key={d.id}
                  active={hostId === d.id}
                  onPress={() => setHostId(d.id)}
                  label={d.name}
                />
              ))}
            </View>
          </Field>
        ) : null}

        {seeded ? null : (
          <Field label="Folder">
            <Pressable
              onPress={() => setBrowsing(true)}
              style={({ pressed }) => [s.folderBtn, pressed && s.pressed80]}
            >
              <PounceIcon
                name="folder-outline"
                size={17}
                color={cwd ? theme.colors.accent : theme.colors.fgFaint}
              />
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
                    <Chip
                      key={r.id}
                      active={activeRepoId === r.id}
                      onPress={() => pickRepo(r.id)}
                      label={r.name}
                    />
                  ))}
              </View>
            ) : null}
          </Field>
        )}
        {/* No Agent field. It moved into the composer's model sheet — an agent
            and its model are one decision, and the rest of the app already
            makes it there. */}
      </ScrollView>

      {/* Same composer as the session view — mode / effort / image / slash.
          `ChatKeyboardSticky` cancels the bottom safe-area inset once the
          keyboard covers it, which is exactly what `footerPad` adds.

          The padding goes on an inner View, not on the sticky itself: the
          sticky is a Reanimated animated view and a unistyles style proxy
          reaches it unresolved ("Invalid value for unistyles_…: an empty
          object is not a valid style value"). Same trap kav.ios.ts documents. */}
      <ChatKeyboardSticky>
        <View style={[s.footer, s.footerPad]}>
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
            ref={composerRef}
            // The same control Session uses — and here it carries the agent too.
            model={{
              label: model ? shortModel(model) : agentLabel(agent),
              onPress: () => setModelSheet(true),
            }}
            onDraftChange={(text) => updateDraft(draftId, { text })}
            agent={agent}
            caps={caps}
            hostId={hostId}
            cwd={cwd}
            placeholder="Describe the task… e.g. Add idempotent retry to the webhook handler"
            onSubmit={launch}
          />
        </View>
      </ChatKeyboardSticky>

      <ModelSheet
        visible={modelSheet}
        hostId={hostId ?? ""}
        agent={agent}
        current={model}
        agents={{ available: availAgents, current: agent, onSelect: pickAgent }}
        onSelect={(id) => {
          setModel(id);
          setModelSheet(false);
        }}
        onClose={() => setModelSheet(false)}
      />

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
    </View>
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

const s = StyleSheet.create((theme, rt) => ({
  /** Safe-area padding in the sheet — applied natively, no re-render. */
  footerPad: { paddingBottom: rt.insets.bottom + 8 },
  emptyTitle: { fontSize: 17, fontWeight: "600", color: theme.colors.fg },
  root: { flex: 1, backgroundColor: theme.colors.bg },
  rootPad: { paddingTop: 8 },
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
  fieldLabel: {
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    color: theme.colors.fgFaint,
  },
  chip: { borderRadius: 999, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 6 },
}));
