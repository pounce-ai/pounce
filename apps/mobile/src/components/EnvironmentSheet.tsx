import { type ReactNode, useEffect, useState } from "react";
import { Modal, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import type { Session } from "@litter/shared";
import { fetchGitChanges, type GitChanges } from "@/services/bridge";
import { COLOR } from "@/ui";

/** One row in the environment sheet — icon · label · trailing value/chevron. */
function Row({
  icon,
  label,
  danger,
  right,
  onPress,
}: {
  icon: ComponentIcon;
  label: string;
  danger?: boolean;
  right?: ReactNode;
  onPress?: () => void;
}) {
  const color = danger ? COLOR.danger : COLOR.fg;
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      className="active:bg-surface-hover flex-row items-center gap-3 rounded-xl px-2 py-2.5"
    >
      <Ionicons name={icon} size={18} color={danger ? COLOR.danger : COLOR.fgMuted} />
      <Text className="flex-1 text-[15px] font-medium" style={{ color }}>
        {label}
      </Text>
      {right}
      {onPress && !right ? <Ionicons name="chevron-forward" size={15} color={COLOR.fgFaint} /> : null}
    </Pressable>
  );
}

type ComponentIcon = React.ComponentProps<typeof Ionicons>["name"];

/**
 * The thread's "Environment" — git changes (with +/- counts), branch, terminal,
 * and stop — as a bottom sheet, replacing the plain action sheet. Codex-style.
 * Markers live in the header now, so they're intentionally not here.
 */
export function EnvironmentSheet({
  visible,
  session,
  running,
  onClose,
  onStop,
  onViewChanges,
  onTerminal,
}: {
  visible: boolean;
  session: Session;
  running: boolean;
  onClose: () => void;
  onStop: () => void;
  onViewChanges: () => void;
  onTerminal: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [git, setGit] = useState<GitChanges | null>(null);

  useEffect(() => {
    if (!visible || !session.cwd) return;
    let cancelled = false;
    fetchGitChanges(session.hostId, session.cwd)
      .then((g) => { if (!cancelled) setGit(g); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [visible, session.hostId, session.cwd]);

  const add = git?.files.reduce((s, f) => s + f.additions, 0) ?? 0;
  const del = git?.files.reduce((s, f) => s + f.deletions, 0) ?? 0;
  const branch = git?.branch ?? session.branch ?? null;
  const act = (run: () => void) => () => { onClose(); run(); };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable className="flex-1 bg-black/50" onPress={onClose} />
      <View
        style={{ paddingBottom: insets.bottom + 12 }}
        className="rounded-t-3xl border-t border-border bg-bg-elevated px-4 pt-3"
      >
        <View className="mb-3 h-1 w-10 self-center rounded-full bg-border" />
        <Text className="mb-1 px-1 text-[12px] uppercase tracking-wide text-fg-faint">Environment</Text>

        {running ? <Row icon="stop-circle-outline" label="Stop agent" danger onPress={act(onStop)} /> : null}

        {session.cwd ? (
          <>
            <Row
              icon="git-compare-outline"
              label="Changes"
              onPress={act(onViewChanges)}
              right={
                add || del ? (
                  <Text className="text-[14px] font-semibold">
                    <Text className="text-diff-add-fg">+{add}</Text>{" "}
                    <Text className="text-diff-del-fg">-{del}</Text>
                  </Text>
                ) : (
                  <Text className="text-[13px] text-fg-faint">No changes</Text>
                )
              }
            />
            {branch ? <Row icon="git-branch-outline" label={branch} /> : null}
            <Row icon="terminal-outline" label="Open terminal" onPress={act(onTerminal)} />
          </>
        ) : (
          <Text className="px-2 py-3 text-[13px] text-fg-muted">
            This session's worktree was removed — no environment to inspect.
          </Text>
        )}
      </View>
    </Modal>
  );
}
