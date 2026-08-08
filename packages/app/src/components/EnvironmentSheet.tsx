import { type ReactNode, useEffect, useState } from "react";
import { NativeSheet } from "./NativeSheet";
import {
  Image,
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
  type ColorValue,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { PounceIcon } from "../ui/native/Icon";
import { IS_DESKTOP } from "../ui";
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
  const { theme } = useUnistyles();
  const color = danger ? theme.colors.danger : theme.colors.fg;
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => [s.row, pressed && s.rowPressed]}
    >
      {leading ??
        (icon ? (
          <PounceIcon
            name={icon}
            size={18}
            color={iconColor ?? (danger ? theme.colors.danger : theme.colors.fgMuted)}
          />
        ) : null)}
      <Text numberOfLines={1} style={[s.rowLabel, { color }]}>
        {label}
      </Text>
      {right}
      {onPress && !right ? (
        <PounceIcon name="chevron-forward" size={15} color={theme.colors.fgFaint} />
      ) : null}
    </Pressable>
  );
}

/** Section heading with an optional trailing "+" action. */
function SectionHeader({ title, onAdd }: { title: string; onAdd?: () => void }) {
  const { theme } = useUnistyles();
  return (
    <View style={s.sectionHeader}>
      <Text style={s.sectionTitle}>{title}</Text>
      {onAdd ? (
        <Pressable onPress={onAdd} hitSlop={6} style={({ pressed }) => pressed && s.pressed60}>
          <PounceIcon name="add" size={18} color={theme.colors.fgFaint} />
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
  /** Open the project's CLAUDE.md/AGENTS.md — read, search, comment. */
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
  const { theme } = useUnistyles();
  const { height } = useWindowDimensions();
  const [git, setGit] = useState<GitChanges | null>(null);
  const [checks, setChecks] = useState<GitChecks | null>(null);
  const [allSources, setAllSources] = useState(false);

  useEffect(() => {
    if (!visible || !session.cwd) return;
    let cancelled = false;
    fetchGitChanges(session.hostId, session.cwd)
      .then((g) => {
        if (!cancelled) setGit(g);
      })
      .catch(() => {});
    fetchGitChecks(session.hostId, session.cwd)
      .then((c) => {
        if (!cancelled) setChecks(c);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [visible, session.hostId, session.cwd]);

  const { add, del } = diffTotals(git?.files ?? []);
  const branch = git?.branch ?? session.branch ?? null;
  const conflicts = git?.conflicts ?? 0;
  const needsCommit = (git?.files.length ?? 0) > 0;
  const needsPush = (git?.ahead ?? 0) > 0;
  const act = (run: () => void) => () => {
    onClose();
    run();
  };

  const CHECK_ROW: Record<string, { icon: ComponentIcon; color: ColorValue; label: string }> = {
    passing: {
      icon: "checkmark-circle-outline",
      color: theme.colors.success,
      label: "Checks successful",
    },
    failing: {
      icon: "close-circle-outline",
      color: theme.colors.danger,
      label: `Checks failing (${checks?.failed}/${checks?.total})`,
    },
    pending: { icon: "time-outline", color: theme.colors.fgMuted, label: "Checks running" },
  };
  const checkRow = checks?.checks ? CHECK_ROW[checks.checks] : null;

  /** Whether the Environment section has any row to show. Mirrors the
   *  conditions below — desktop keeps only the states that are genuinely
   *  exceptional (a failing check, a conflict), since everything routine lives
   *  on screen already. */
  const hasEnvironment =
    !session.cwd ||
    !!checkRow ||
    conflicts > 0 ||
    !IS_DESKTOP ||
    (running && !IS_DESKTOP);


  const shownSources = allSources ? sources : sources.slice(0, SOURCES_COLLAPSED);

  return (
    <NativeSheet visible={visible} onClose={onClose}>
      <ScrollView bounces={false} style={{ maxHeight: height * 0.7 }}>
        {/* Markers moved to the composer's pill row (next to the model pill). */}
        {/* Favouriting is a one-tap toggle, so on desktop it's a star in the
            tab strip rather than a row you open a menu to reach. */}
        {onToggleFavourite && !IS_DESKTOP ? (
          <>
            <SectionHeader title="Thread" />
            <Row
              icon={fav ? "star" : "star-outline"}
              iconColor={fav ? theme.colors.accent : undefined}
              label={fav ? "Remove from favourites" : "Add to favourites"}
              onPress={act(onToggleFavourite)}
            />
            <View style={s.divider} />
          </>
        ) : null}
        {/* On desktop this section can now be empty: every row it used to hold
            is standing UI there (the diff pane, the status bar, the terminal
            dock) or has moved to the Space page. A header with nothing under it
            reads as something failing to load, so it only appears when it has
            something to say. */}
        {hasEnvironment ? <SectionHeader title="Environment" /> : null}

        {/* Desktop's composer shows a stop button while a turn runs, right where
            you're already looking — reaching a menu to halt something is the
            wrong shape for the most time-sensitive action in the app. */}
        {running && !IS_DESKTOP ? (
          <Row icon="stop-circle-outline" label="Stop agent" danger onPress={act(onStop)} />
        ) : null}

        {session.cwd ? (
          <>
            {/* Changes, host, branch and commit/push are all standing UI on
                desktop — the docked diff pane owns the diff and its commit /
                push / PR buttons, and the status bar shows checkout + branch.
                Repeating them here would be a menu of things already on screen. */}
            {!IS_DESKTOP ? (
              <>
                <Row
                  icon="git-compare-outline"
                  label="Changes"
                  onPress={act(onViewChanges)}
                  right={
                    add || del ? (
                      <Text style={s.diffCounts}>
                        <Text style={s.diffAdd}>+{add}</Text> <Text style={s.diffDel}>-{del}</Text>
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
              </>
            ) : null}
            {checkRow ? (
              <Row icon={checkRow.icon} iconColor={checkRow.color} label={checkRow.label} />
            ) : null}
            {conflicts > 0 ? (
              <Row
                icon="close-circle-outline"
                label="Merge conflicts"
                danger
                onPress={onFixConflicts ? act(onFixConflicts) : undefined}
                right={onFixConflicts ? <Text style={s.fixLabel}>Fix</Text> : undefined}
              />
            ) : null}
            {/* Project context moved to the Space page — it describes the
                CHECKOUT, not this thread, and every session here shares it.
                Reaching it through whichever thread you had open was the wrong
                door. */}
            {/* Terminal is a docked panel on desktop (⌃` or the tab-strip
                button), so a menu item that opens a separate screen is a second
                worse way to the same place. The phone has no dock, so it keeps
                this row — it's the only route there. */}
            {!IS_DESKTOP ? (
              <Row icon="terminal-outline" label="Open terminal" onPress={act(onTerminal)} />
            ) : null}
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
            Drop files or folders on the chat — or type @ in the composer — to give the agent
            context.
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
                      <PounceIcon name="close" size={15} color={theme.colors.fgFaint} />
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

const s = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 10,
  },
  rowPressed: { backgroundColor: theme.colors.surfaceHover },
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
    color: theme.colors.fgFaint,
  },
  divider: { marginVertical: 8, height: 1, backgroundColor: theme.colors.border },
  markerCount: { fontSize: 13, fontWeight: "600", color: theme.colors.fgMuted },
  diffCounts: { fontSize: 14, fontWeight: "600" },
  diffAdd: { color: theme.colors.diffAddFg },
  diffDel: { color: theme.colors.diffDelFg },
  noChanges: { fontSize: 13, color: theme.colors.fgFaint },
  fixLabel: { fontSize: 14, fontWeight: "500", color: theme.colors.fgMuted },
  emptyEnv: {
    paddingHorizontal: 8,
    paddingVertical: 12,
    fontSize: 13,
    color: theme.colors.fgMuted,
  },
  emptySources: {
    paddingHorizontal: 8,
    paddingVertical: 8,
    fontSize: 13,
    color: theme.colors.fgMuted,
  },
  sourceThumb: { height: 28, width: 28, borderRadius: 6, backgroundColor: theme.colors.surface },
  pressed60: { opacity: 0.6 },
}));
