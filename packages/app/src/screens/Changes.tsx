import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Linking, Pressable, Text, TextInput, View } from "react-native";
import { KeyboardAvoidingView, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import {
  diffTotals,
  fetchGitChanges,
  gitBranch,
  gitCommit,
  gitPush,
  gitPR,
  gitSuggest,
  type GitChanges,
  type GitSuggestion,
} from "../services/bridge";
import { DiffView } from "../components/DiffView";
import { extOf } from "../components/diffPatch";
import { seenFiles$, setSeenFile } from "../state/stores";
import { useSelector } from "@legendapp/state/react";
import { useThread } from "../state/db/hooks";
import { cn, COLOR, IS_DESKTOP, pickSheet } from "../ui";

/** Branches where committing directly is almost never intended. */
const isMainBranch = (b: string | null | undefined) => b === "main" || b === "master";

const NO_SEEN: string[] = [];

export default function ChangesScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const session = useThread(id);

  const [changes, setChanges] = useState<GitChanges | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<null | "commit" | "push" | "pr">(null);
  // Draft is the default PR mode — the chevron on the button switches it.
  const [prDraft, setPrDraft] = useState(true);
  const [layout, setLayout] = useState<"unified" | "split">("unified");
  // GitHub-style file filter: by extension, via a dropdown with counts.
  const [extFilter, setExtFilter] = useState<string | null>(null);
  // Files marked "Seen" — persisted per thread so they come back collapsed.
  // Stable identities matter: DiffView is memoized because its props cross the
  // WebView bridge, so a fresh [] or closure per keystroke would re-marshal it.
  const seenPaths = useSelector(() => seenFiles$[id!].get()) ?? NO_SEEN;
  const onToggleSeen = useCallback(async (path: string, seen: boolean) => setSeenFile(id!, path, seen), [id]);

  const load = useCallback(async () => {
    if (!session?.cwd) return;
    setLoading(true);
    try {
      setChanges(await fetchGitChanges(session.hostId, session.cwd));
    } finally {
      setLoading(false);
    }
  }, [session?.hostId, session?.cwd]);

  useEffect(() => {
    void load();
  }, [load]);

  const totals = useMemo(() => diffTotals(changes?.files ?? []), [changes?.files]);
  const fileCount = changes?.files.length ?? 0;

  /** Extensions present in the change set, with counts — ordered by count. */
  const extensions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const f of changes?.files ?? []) {
      const e = extOf(f.path);
      counts.set(e, (counts.get(e) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [changes?.files]);

  const pickExtFilter = () =>
    pickSheet("Filter by file type", [
      `All files (${fileCount})`,
      ...extensions.map(([ext, n]) => `${ext} (${n})`),
    ], (i) => setExtFilter(i === 0 ? null : extensions[i - 1][0]));

  /** Model suggestion, or null after telling the user why it failed. */
  const suggest = async (): Promise<GitSuggestion | null> => {
    if (!session?.cwd) return null;
    const s = await gitSuggest(session.hostId, session.cwd);
    if (!s?.ok) {
      Alert.alert("Couldn't generate", s?.error || "The host's claude CLI didn't respond.");
      return null;
    }
    return s;
  };

  /** One explicit approval before anything generated is acted on. */
  const approve = (title: string, detail: string, action: string) =>
    new Promise<boolean>((resolve) => {
      Alert.alert(title, detail, [
        { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
        { text: action, onPress: () => resolve(true) },
      ]);
    });

  const doCommit = async (msg: string): Promise<boolean> => {
    if (!session?.cwd) return false;
    const r = await gitCommit(session.hostId, session.cwd, msg);
    if (!r?.ok) {
      Alert.alert("Commit failed", r?.error || "Could not commit.");
      return false;
    }
    setMessage("");
    return true;
  };

  // Commit: an empty message generates one, shows it in the field, and asks
  // for one approval before committing. A typed message commits directly.
  const commit = async () => {
    if (!session?.cwd) return;
    setBusy("commit");
    try {
      let msg = message.trim();
      if (!msg) {
        const s = await suggest();
        if (!s?.commitMessage) return;
        msg = s.commitMessage;
        setMessage(msg); // visible + editable even if they cancel
        if (!(await approve("Commit with generated message?", msg, "Commit"))) return;
      }
      if (await doCommit(msg)) {
        await load();
      }
    } finally {
      setBusy(null);
    }
  };

  // Push: with a clean tree it's a plain push. With uncommitted changes it
  // generates what's missing (commit message; branch name when on main),
  // shows the full plan, and runs branch→commit→push after one approval.
  const push = async () => {
    if (!session?.cwd) return;
    setBusy("push");
    try {
      if (fileCount === 0) {
        const r = await gitPush(session.hostId, session.cwd);
        Alert.alert(r?.ok ? "Pushed" : "Push failed", r?.output || "");
        return;
      }
      const onMain = isMainBranch(changes?.branch ?? session.branch);
      let msg = message.trim();
      let branchName: string | undefined;
      if (!msg || onMain) {
        const s = await suggest();
        if (!s) return;
        if (!msg && s.commitMessage) {
          msg = s.commitMessage;
          setMessage(msg);
        }
        branchName = onMain ? s.branchName : undefined;
      }
      if (!msg) return;
      const plan = [
        onMain && branchName ? `Create branch ${branchName} (you're on ${changes?.branch})` : null,
        `Commit: ${msg.split("\n")[0]}`,
        "Push to origin",
      ].filter(Boolean).join("\n");
      if (!(await approve("Commit & push?", plan, "Commit & push"))) return;
      if (onMain && branchName) {
        const b = await gitBranch(session.hostId, session.cwd, branchName);
        if (!b?.ok) {
          Alert.alert("Branch failed", b?.error || `Couldn't create ${branchName}.`);
          return;
        }
      }
      if (!(await doCommit(msg))) return;
      const r = await gitPush(session.hostId, session.cwd);
      Alert.alert(r?.ok ? "Pushed" : "Push failed", r?.output || "");
      await load();
    } finally {
      setBusy(null);
    }
  };

  // PR: generate title/body, get one approval, then create (draft by default).
  const openPR = async () => {
    if (!session?.cwd) return;
    setBusy("pr");
    try {
      const s = await suggest();
      const title = s?.prTitle;
      const body = s?.prBody;
      const label = prDraft ? "Create draft PR" : "Create PR";
      const detail = title ? `${title}\n\n${body ?? ""}`.trim() : "gh will fill the title/body from commits.";
      if (!(await approve(prDraft ? "Draft PR" : "PR", detail, label))) return;
      const r = await gitPR(session.hostId, session.cwd, { title, body, draft: prDraft });
      if (r?.ok && r.url) {
        await Linking.openURL(r.url);
      } else {
        Alert.alert("Couldn't open PR", r?.error || "Is `gh` installed and authed on the host?");
      }
    } finally {
      setBusy(null);
    }
  };

  const pickPrMode = () => pickSheet("Pull request mode", ["Draft PR", "PR"], (i) => setPrDraft(i === 0));

  return (
    <KeyboardAvoidingView
      className="flex-1 bg-bg"
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={{ paddingTop: insets.top + 6 }}
    >
      {/* Header */}
      <View className="flex-row items-center gap-2 px-3 pb-2">
        <Pressable onPress={() => router.back()} className="active:opacity-60 h-9 w-9 items-center justify-center">
          <Ionicons name="chevron-down" size={22} color={COLOR.fg} />
        </Pressable>
        <View className="min-w-0 flex-1">
          <Text className="text-[17px] font-semibold text-fg">Changes</Text>
          <View className="mt-0.5 min-w-0 flex-row items-center gap-2">
            {changes?.branch ? (
              <Text numberOfLines={1} className="shrink font-mono text-[12px] text-fg-faint">
                ⎇ {changes.branch}
              </Text>
            ) : null}
            {fileCount > 0 ? (
              <Text numberOfLines={1} className="shrink-0 text-[12px] text-fg-muted">
                {fileCount} file{fileCount === 1 ? "" : "s"} ·{" "}
                <Text className="text-diff-add-fg">+{totals.add}</Text>{" "}
                <Text className="text-diff-del-fg">−{totals.del}</Text>
              </Text>
            ) : null}
          </View>
        </View>
        {IS_DESKTOP && fileCount > 0 ? (
          <View className="flex-row overflow-hidden rounded-lg border border-border">
            {(["unified", "split"] as const).map((l) => (
              <Pressable
                key={l}
                onPress={() => setLayout(l)}
                className={cn("px-2.5 py-1", layout === l ? "bg-surface-alt" : "bg-transparent")}
              >
                <Text className={cn("text-[12px] font-medium", layout === l ? "text-fg" : "text-fg-faint")}>
                  {l === "unified" ? "Unified" : "Split"}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        {fileCount > 1 ? (
          <Pressable
            onPress={pickExtFilter}
            className={cn(
              "active:opacity-70 h-7 flex-row items-center gap-1 rounded-lg border px-2",
              extFilter ? "border-accent bg-accent-soft" : "border-border bg-transparent",
            )}
          >
            <Ionicons name="filter" size={13} color={extFilter ? COLOR.accent : COLOR.fgMuted} />
            <Text className={cn("text-[12px] font-medium", extFilter ? "text-accent" : "text-fg-muted")}>
              {extFilter ?? "Filter"}
            </Text>
          </Pressable>
        ) : null}
        <Pressable onPress={load} className="active:opacity-60 h-9 w-9 items-center justify-center">
          <Ionicons name="refresh" size={18} color={COLOR.fgMuted} />
        </Pressable>
      </View>

      {/* Diff */}
      <View className="flex-1 border-t border-border">
        {loading ? (
          <View className="flex-1 items-center justify-center">
            <ActivityIndicator color={COLOR.accent} />
          </View>
        ) : fileCount === 0 ? (
          <View className="flex-1 items-center justify-center px-8">
            <Text className="text-[40px]">✨</Text>
            <Text className="mt-3 text-center text-[15px] font-semibold text-fg">Working tree clean</Text>
            <Text className="mt-1 text-center text-[13px] text-fg-muted">No uncommitted changes in this worktree.</Text>
          </View>
        ) : (
          <DiffView
            patch={changes?.diff ?? ""}
            layout={layout}
            extFilter={extFilter}
            seenPaths={seenPaths}
            onToggleSeen={onToggleSeen}
          />
        )}
      </View>

      {/* Actions */}
      {fileCount > 0 ? (
        <View style={{ paddingBottom: insets.bottom + 8 }} className="border-t border-border bg-bg-elevated px-3 pt-2">
          <TextInput
            value={message}
            onChangeText={setMessage}
            editable={!busy}
            placeholder="Commit message — leave empty to generate…"
            placeholderTextColor="#62626D"
            className="max-h-[90px] min-h-[40px] rounded-2xl bg-surface-alt px-3 pt-2 text-[14px] text-fg"
            multiline
          />
          <View className="mt-2 flex-row gap-2">
            <Pressable
              onPress={commit}
              disabled={busy != null}
              className={cn(
                "h-9 flex-1 items-center justify-center rounded-xl bg-accent",
                busy != null && "opacity-40",
              )}
            >
              {busy === "commit" ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Text className="text-[13px] font-semibold text-white">Commit</Text>
              )}
            </Pressable>
            <SecondaryButton label="Push" icon="cloud-upload-outline" busy={busy === "push"} onPress={push} disabled={busy != null} />
            <View className="flex-1 flex-row overflow-hidden rounded-xl border border-border bg-surface-alt">
              <Pressable
                onPress={openPR}
                disabled={busy != null}
                className={cn(
                  "h-9 flex-1 flex-row items-center justify-center gap-1.5 active:bg-surface-hover",
                  busy != null && "opacity-50",
                )}
              >
                {busy === "pr" ? (
                  <ActivityIndicator color={COLOR.fgMuted} size="small" />
                ) : (
                  <Ionicons name="git-pull-request-outline" size={15} color={COLOR.fgMuted} />
                )}
                <Text className="text-[13px] font-medium text-fg-muted">{prDraft ? "Draft PR" : "PR"}</Text>
              </Pressable>
              <Pressable
                onPress={pickPrMode}
                disabled={busy != null}
                className="h-9 items-center justify-center border-l border-border px-2 active:bg-surface-hover"
              >
                <Ionicons name="chevron-down" size={13} color={COLOR.fgFaint} />
              </Pressable>
            </View>
          </View>
        </View>
      ) : null}
    </KeyboardAvoidingView>
  );
}

function SecondaryButton({
  label,
  icon,
  busy,
  onPress,
  disabled,
}: {
  label: string;
  icon: React.ComponentProps<typeof Ionicons>["name"];
  busy: boolean;
  onPress: () => void;
  disabled: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      className={cn(
        "h-9 flex-1 flex-row items-center justify-center gap-1.5 rounded-xl border border-border bg-surface-alt active:bg-surface-hover",
        disabled && "opacity-50",
      )}
    >
      {busy ? (
        <ActivityIndicator color={COLOR.fgMuted} size="small" />
      ) : (
        <Ionicons name={icon} size={15} color={COLOR.fgMuted} />
      )}
      <Text className="text-[13px] font-medium text-fg-muted">{label}</Text>
    </Pressable>
  );
}
