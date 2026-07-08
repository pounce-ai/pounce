import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Linking, Pressable, Text, TextInput, View } from "react-native";
import { KeyboardAvoidingView, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { DiffsView, type Theme } from "react-native-diffs";
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

/** Native diff theme mapped onto Pounce's dark palette. */
const DIFF_THEME: Theme = {
  fonts: { codeSize: 12 },
  colors: {
    body: COLOR.fg,
    code: "#cdd0d6",
    codeBackground: "#0d0d12",
    highlight: COLOR.accent,
    emphasis: COLOR.fgMuted,
    selectionTint: COLOR.accent,
  },
  diff: {
    displayMode: "unified",
    changeHighlightStyle: "both",
    backgroundColor: "#0B0B0F",
    gutterBackground: "#0d0d12",
    gutterText: "#52525b",
    addedLineBackground: "#22c55e1f",
    removedLineBackground: "#dc26261f",
    addedHighlightBackground: "#4ade8055",
    removedHighlightBackground: "#dc262655",
    hunkHeaderBackground: "#1b1b22",
    hunkHeaderText: "#71717a",
    separatorColor: "#26262f",
    borderWidth: 0,
  },
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
          <DiffsView
            content={changes?.diff ?? ""}
            colorScheme="dark"
            showsBlockHeaders={false}
            theme={DIFF_THEME}
            style={{ flex: 1, backgroundColor: "#0B0B0F" }}
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
