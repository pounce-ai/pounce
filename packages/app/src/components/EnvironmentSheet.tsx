import { type ReactNode, useEffect, useState } from "react";
import { NativeSheet } from "./NativeSheet";
import {
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type ColorValue,
} from "react-native";
import { PounceIcon } from "../ui/native/Icon";
import type { IoniconName } from "../ui/native/icon-map";
import type { Session } from "@pounce/shared";
import {
  diffTotals,
  fetchGitChanges,
  fetchGitChecks,
  type GitChanges,
  type GitChecks,
} from "../services/bridge";
import type { ThreadSource } from "../state/stores";
import { COLOR } from "../ui";
import { T } from "../ui/theme";

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
  iconColor?: ColorValue;
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
      style={({ pressed }) => [s.row, pressed && s.rowPressed]}
    >
      {leading ??
        (icon ? (
          <PounceIcon name={icon} size={18} color={iconColor ?? (danger ? COLOR.danger : COLOR.fgMuted)} />
        ) : null)}
      <Text numberOfLines={1} style={[s.rowLabel, { color }]}>
        {label}
      </Text>
      {right}
      {onPress && !right ? <PounceIcon name="chevron-forward" size={15} color={COLOR.fgFaint} /> : null}
    </Pressable>
  );
}

/** Section heading with an optional trailing "+" action. */
function SectionHeader({ title, onAdd }: { title: string; onAdd?: () => void }) {
  return (
    <View style={s.sectionHeader}>
      <Text style={s.sectionTitle}>{title}</Text>
      {onAdd ? (
        <Pressable onPress={onAdd} hitSlop={6} style={({ pressed }) => pressed && s.pressed60}>
          <PounceIcon name="add" size={18} color={COLOR.fgFaint} />
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

type ComponentIcon = IoniconName;

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
  fav,
  onToggleFavourite,
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
  /** Thread actions — favourite toggle and the markers sheet moved here from
   *  the session header to keep it uncluttered. */
  fav?: boolean;
  onToggleFavourite?: () => void;
}) {
  const { height } = useWindowDimensions();
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

  const CHECK_ROW: Record<string, { icon: ComponentIcon; color: ColorValue; label: string }> = {
    passing: { icon: "checkmark-circle-outline", color: COLOR.success, label: "Checks successful" },
    failing: { icon: "close-circle-outline", color: COLOR.danger, label: `Checks failing (${checks?.failed}/${checks?.total})` },
    pending: { icon: "time-outline", color: COLOR.fgMuted, label: "Checks running" },
  };
  const checkRow = checks?.checks ? CHECK_ROW[checks.checks] : null;

  const shownSources = allSources ? sources : sources.slice(0, SOURCES_COLLAPSED);

  return (
    <NativeSheet visible={visible} onClose={onClose}>
        <ScrollView bounces={false} style={{ maxHeight: height * 0.7 }}>
        {/* Markers moved to the composer's pill row (next to the model pill). */}
        {onToggleFavourite ? (
          <>
            <SectionHeader title="Thread" />
            {onToggleFavourite ? (
              <Row
                icon={fav ? "star" : "star-outline"}
                iconColor={fav ? COLOR.accent : undefined}
                label={fav ? "Remove from favourites" : "Add to favourites"}
                onPress={act(onToggleFavourite)}
              />
            ) : null}
            <View style={s.divider} />
          </>
        ) : null}
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
                  <Text style={s.diffCounts}>
                    <Text style={s.diffAdd}>+{add}</Text>{" "}
                    <Text style={s.diffDel}>-{del}</Text>
                  </Text>
                ) : (
                  <Text style={s.noChanges}>No changes</Text>
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
                    <Text style={s.fixLabel}>Fix</Text>
                  ) : undefined
                }
              />
            ) : null}
            <Row icon="terminal-outline" label="Open terminal" onPress={act(onTerminal)} />
          </>
        ) : (
          <Text style={s.emptyEnv}>
            This session's worktree was removed — no environment to inspect.
          </Text>
        )}

        <View style={s.divider} />
        <SectionHeader title="Sources" onAdd={onAddSource ? act(onAddSource) : undefined} />

        {sources.length === 0 ? (
          <Text style={s.emptySources}>
            Drop files or folders on the chat — or type @ in the composer — to give the agent context.
          </Text>
        ) : (
          <>
            {shownSources.map((src) => (
              <Row
                key={src.path}
                icon={SOURCE_ICON[src.kind]}
                leading={
                  src.kind === "image" ? (
                    <Image
                      source={{ uri: sourceFileUri(src.path, session.cwd) }}
                      style={s.sourceThumb}
                    />
                  ) : undefined
                }
                label={src.name}
                right={
                  onRemoveSource ? (
                    <Pressable
                      onPress={() => onRemoveSource(src.path)}
                      hitSlop={8}
                      style={({ pressed }) => pressed && s.pressed60}
                    >
                      <PounceIcon name="close" size={15} color={COLOR.fgFaint} />
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
    </NativeSheet>
  );
}

const s = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 10,
  },
  rowPressed: { backgroundColor: T.surfaceHover },
  rowLabel: { flex: 1, fontSize: 15, fontWeight: "500" },
  sectionHeader: {
    marginBottom: 4,
    marginTop: 4,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 4,
  },
  sectionTitle: {
    flex: 1,
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    color: T.fgFaint,
  },
  divider: { marginVertical: 8, height: 1, backgroundColor: T.border },
  markerCount: { fontSize: 13, fontWeight: "600", color: T.fgMuted },
  diffCounts: { fontSize: 14, fontWeight: "600" },
  diffAdd: { color: T.diffAddFg },
  diffDel: { color: T.diffDelFg },
  noChanges: { fontSize: 13, color: T.fgFaint },
  fixLabel: { fontSize: 14, fontWeight: "500", color: T.fgMuted },
  emptyEnv: { paddingHorizontal: 8, paddingVertical: 12, fontSize: 13, color: T.fgMuted },
  emptySources: { paddingHorizontal: 8, paddingVertical: 8, fontSize: 13, color: T.fgMuted },
  sourceThumb: { height: 28, width: 28, borderRadius: 6, backgroundColor: T.surface },
  pressed60: { opacity: 0.6 },
});
