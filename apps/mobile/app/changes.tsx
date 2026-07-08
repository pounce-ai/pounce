import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Linking, Pressable, Text, TextInput, View } from "react-native";
import { KeyboardAvoidingView, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LegendList } from "@legendapp/list/react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSelector } from "@legendapp/state/react";
import { Ionicons } from "@expo/vector-icons";
import {
  fetchGitChanges,
  gitCommit,
  gitPush,
  gitPR,
  type GitChanges,
} from "@/services/bridge";
import { sessions$ } from "@/state/stores";
import { cn, COLOR } from "@/ui";

type Kind = "header" | "hunk" | "add" | "del" | "ctx";

function classify(line: string): Kind {
  if (line.startsWith("@@")) return "hunk";
  if (/^(diff --git|index |--- |\+\+\+ |new file|deleted file|rename )/.test(line)) return "header";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "ctx";
}

const LINE_CLASS: Record<Kind, string> = {
  header: "text-fg-faint",
  hunk: "text-info",
  add: "bg-diff-add-bg text-diff-add-fg",
  del: "bg-diff-del-bg text-diff-del-fg",
  ctx: "text-fg-muted",
};

export default function ChangesScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const session = useSelector(() => sessions$[id!].get());

  const [changes, setChanges] = useState<GitChanges | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<null | "commit" | "push" | "pr">(null);

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

  const lines = useMemo(() => (changes?.diff ? changes.diff.split("\n") : []), [changes?.diff]);
  const totals = useMemo(() => {
    const f = changes?.files ?? [];
    return { add: f.reduce((s, x) => s + x.additions, 0), del: f.reduce((s, x) => s + x.deletions, 0) };
  }, [changes?.files]);

  const commit = async () => {
    if (!session?.cwd || !message.trim()) return;
    setBusy("commit");
    try {
      const r = await gitCommit(session.hostId, session.cwd, message.trim());
      if (r?.ok) {
        setMessage("");
        Alert.alert("Committed", `Created commit ${r.sha}`);
        await load();
      } else {
        Alert.alert("Commit failed", r?.error || "Could not commit.");
      }
    } finally {
      setBusy(null);
    }
  };

  const push = async () => {
    if (!session?.cwd) return;
    setBusy("push");
    try {
      const r = await gitPush(session.hostId, session.cwd);
      Alert.alert(r?.ok ? "Pushed" : "Push failed", r?.output || "");
    } finally {
      setBusy(null);
    }
  };

  const openPR = async () => {
    if (!session?.cwd) return;
    setBusy("pr");
    try {
      const r = await gitPR(session.hostId, session.cwd);
      if (r?.ok && r.url) {
        await Linking.openURL(r.url);
      } else {
        Alert.alert("Couldn't open PR", r?.error || "Is `gh` installed and authed on the host?");
      }
    } finally {
      setBusy(null);
    }
  };

  const fileCount = changes?.files.length ?? 0;

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
        <View className="flex-1">
          <Text className="text-[17px] font-semibold text-fg">Changes</Text>
          <View className="mt-0.5 flex-row items-center gap-2">
            {changes?.branch ? (
              <Text numberOfLines={1} className="font-mono text-[12px] text-fg-faint">⎇ {changes.branch}</Text>
            ) : null}
            {fileCount > 0 ? (
              <Text className="text-[12px] text-fg-muted">
                {fileCount} file{fileCount === 1 ? "" : "s"} ·{" "}
                <Text className="text-diff-add-fg">+{totals.add}</Text>{" "}
                <Text className="text-diff-del-fg">−{totals.del}</Text>
              </Text>
            ) : null}
          </View>
        </View>
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
          <LegendList
            data={lines}
            keyExtractor={(_, i) => String(i)}
            estimatedItemSize={18}
            renderItem={({ item }) => {
              const kind = classify(item);
              return (
                <Text className={cn("px-3 font-mono text-[11px] leading-[18px]", LINE_CLASS[kind])}>
                  {item || " "}
                </Text>
              );
            }}
            contentContainerStyle={{ paddingVertical: 6 }}
          />
        )}
      </View>

      {/* Actions */}
      {fileCount > 0 ? (
        <View style={{ paddingBottom: insets.bottom + 8 }} className="border-t border-border bg-bg-elevated px-3 pt-2">
          <View className="flex-row items-end gap-2">
            <TextInput
              value={message}
              onChangeText={setMessage}
              editable={!busy}
              placeholder="Commit message…"
              placeholderTextColor="#62626D"
              className="max-h-[90px] min-h-[40px] flex-1 rounded-2xl bg-surface-alt px-3 pt-2 text-[14px] text-fg"
              multiline
            />
            <Pressable
              onPress={commit}
              disabled={!message.trim() || busy != null}
              className={cn(
                "h-10 items-center justify-center rounded-full bg-accent px-4",
                (!message.trim() || busy != null) && "opacity-40",
              )}
            >
              {busy === "commit" ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Text className="text-[14px] font-semibold text-white">Commit</Text>
              )}
            </Pressable>
          </View>
          <View className="mt-2 flex-row gap-2">
            <SecondaryButton label="Push" icon="cloud-upload-outline" busy={busy === "push"} onPress={push} disabled={busy != null} />
            <SecondaryButton label="Open PR" icon="git-pull-request-outline" busy={busy === "pr"} onPress={openPR} disabled={busy != null} />
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
