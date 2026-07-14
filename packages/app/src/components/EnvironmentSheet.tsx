import { type ReactNode, useEffect, useState } from "react";
import { Modal } from "./AppModal";
import { Image, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import type { Session } from "@litter/shared";
import {
  diffTotals,
  fetchGitChanges,
  fetchGitChecks,
  type GitChanges,
  type GitChecks,
} from "../services/bridge";
import type { ThreadSource } from "../state/stores";
import { COLOR } from "../ui";

/** One row in the environment sheet — icon · label · trailing value/chevron. */
function Row({
  icon,
  iconColor,
  leading,
  label,
  danger,
  right,
  onPress,
}: {
  icon?: ComponentIcon;
  iconColor?: string;
  /** Custom leading element (e.g. an image thumbnail) instead of an icon. */
  leading?: ReactNode;
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
      {leading ??
        (icon ? (
          <Ionicons name={icon} size={18} color={iconColor ?? (danger ? COLOR.danger : COLOR.fgMuted)} />
        ) : null)}
      <Text numberOfLines={1} className="flex-1 text-[15px] font-medium" style={{ color }}>
        {label}
      </Text>
      {right}
      {onPress && !right ? <Ionicons name="chevron-forward" size={15} color={COLOR.fgFaint} /> : null}
    </Pressable>
  );
}

/** Section heading with an optional trailing "+" action. */
function SectionHeader({ title, onAdd }: { title: string; onAdd?: () => void }) {
  return (
    <View className="mb-1 mt-1 flex-row items-center px-1">
      <Text className="flex-1 text-[12px] uppercase tracking-wide text-fg-faint">{title}</Text>
      {onAdd ? (
        <Pressable onPress={onAdd} hitSlop={6} className="active:opacity-60">
          <Ionicons name="add" size={18} color={COLOR.fgFaint} />
        </Pressable>
      ) : null}
    </View>
  );
}

const SOURCE_ICON: Record<ThreadSource["kind"], ComponentIcon> = {
  dir: "folder-outline",
  image: "image-outline",
  file: "document-text-outline",
};

/** How many sources show before the list collapses behind "View all". */
const SOURCES_COLLAPSED = 3;

/** file:// URI for an image source — relative paths resolve against the
 *  worktree. Only meaningful where the file is on this machine (desktop). */
function sourceFileUri(path: string, cwd: string | null | undefined): string {
  const abs = path.startsWith("/") ? path : `${cwd ?? ""}/${path}`;
  return `file://${encodeURI(abs)}`;
}

type ComponentIcon = React.ComponentProps<typeof Ionicons>["name"];

/**
 * The thread's "Environment" — git changes (with +/- counts), host, branch,
 * commit-or-push, the task, CI checks, merge conflicts, and the attached
 * Sources — as a bottom sheet. Codex-style. Markers live in the header now,
 * so they're intentionally not here.
 */
export function EnvironmentSheet({
  visible,
  session,
  running,
  sources = [],
  onClose,
  onStop,
  onViewChanges,
  onTerminal,
  onAddSource,
  onRemoveSource,
  onFixConflicts,
}: {
  visible: boolean;
  session: Session;
  running: boolean;
  sources?: ThreadSource[];
  onClose: () => void;
  onStop: () => void;
  onViewChanges: () => void;
  onTerminal: () => void;
  /** "+" on the Sources header — e.g. focus the composer's @-mention. */
  onAddSource?: () => void;
  onRemoveSource?: (path: string) => void;
  /** "Fix" on the merge-conflicts row — hand the cleanup to the agent. */
  onFixConflicts?: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [git, setGit] = useState<GitChanges | null>(null);
  const [checks, setChecks] = useState<GitChecks | null>(null);
  const [allSources, setAllSources] = useState(false);

  useEffect(() => {
    if (!visible || !session.cwd) return;
    let cancelled = false;
    fetchGitChanges(session.hostId, session.cwd)
      .then((g) => { if (!cancelled) setGit(g); })
      .catch(() => {});
    fetchGitChecks(session.hostId, session.cwd)
      .then((c) => { if (!cancelled) setChecks(c); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [visible, session.hostId, session.cwd]);

  const { add, del } = diffTotals(git?.files ?? []);
  const branch = git?.branch ?? session.branch ?? null;
  const conflicts = git?.conflicts ?? 0;
  const needsCommit = (git?.files.length ?? 0) > 0;
  const needsPush = (git?.ahead ?? 0) > 0;
  const act = (run: () => void) => () => { onClose(); run(); };

  const CHECK_ROW: Record<string, { icon: ComponentIcon; color: string; label: string }> = {
    passing: { icon: "checkmark-circle-outline", color: COLOR.success, label: "Checks successful" },
    failing: { icon: "close-circle-outline", color: COLOR.danger, label: `Checks failing (${checks?.failed}/${checks?.total})` },
    pending: { icon: "time-outline", color: COLOR.fgMuted, label: "Checks running" },
  };
  const checkRow = checks?.checks ? CHECK_ROW[checks.checks] : null;

  const shownSources = allSources ? sources : sources.slice(0, SOURCES_COLLAPSED);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable className="flex-1 bg-black/50" onPress={onClose} />
      <View
        style={{ paddingBottom: insets.bottom + 12, maxHeight: "80%" }}
        className="rounded-t-3xl border-t border-border bg-bg-elevated px-4 pt-3"
      >
        <View className="mb-3 h-1 w-10 self-center rounded-full bg-border" />
        <ScrollView bounces={false}>
        <SectionHeader title="Environment" />

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
            <Row icon="laptop-outline" label={session.host || "Local"} />
            {branch ? <Row icon="git-branch-outline" label={branch} /> : null}
            {needsCommit || needsPush ? (
              <Row
                icon="git-commit-outline"
                label={needsCommit ? "Commit or push" : "Push"}
                onPress={act(onViewChanges)}
              />
            ) : null}
            {checkRow ? <Row icon={checkRow.icon} iconColor={checkRow.color} label={checkRow.label} /> : null}
            {conflicts > 0 ? (
              <Row
                icon="close-circle-outline"
                label="Merge conflicts"
                danger
                onPress={onFixConflicts ? act(onFixConflicts) : undefined}
                right={
                  onFixConflicts ? (
                    <Text className="text-[14px] font-medium text-fg-muted">Fix</Text>
                  ) : undefined
                }
              />
            ) : null}
            <Row icon="terminal-outline" label="Open terminal" onPress={act(onTerminal)} />
          </>
        ) : (
          <Text className="px-2 py-3 text-[13px] text-fg-muted">
            This session's worktree was removed — no environment to inspect.
          </Text>
        )}

        <View className="my-2 h-px bg-border/60" />
        <SectionHeader title="Sources" onAdd={onAddSource ? act(onAddSource) : undefined} />

        {sources.length === 0 ? (
          <Text className="px-2 py-2 text-[13px] text-fg-muted">
            Drop files or folders on the chat — or type @ in the composer — to give the agent context.
          </Text>
        ) : (
          <>
            {shownSources.map((s) => (
              <Row
                key={s.path}
                icon={SOURCE_ICON[s.kind]}
                leading={
                  s.kind === "image" ? (
                    <Image
                      source={{ uri: sourceFileUri(s.path, session.cwd) }}
                      className="h-7 w-7 rounded-md bg-surface"
                    />
                  ) : undefined
                }
                label={s.name}
                right={
                  onRemoveSource ? (
                    <Pressable onPress={() => onRemoveSource(s.path)} hitSlop={8} className="active:opacity-60">
                      <Ionicons name="close" size={15} color={COLOR.fgFaint} />
                    </Pressable>
                  ) : undefined
                }
              />
            ))}
            {sources.length > SOURCES_COLLAPSED ? (
              <Row
                icon="link-outline"
                label={allSources ? "Show fewer" : `View all (${sources.length})`}
                onPress={() => setAllSources((v) => !v)}
              />
            ) : null}
          </>
        )}
        </ScrollView>
      </View>
    </Modal>
  );
}
