import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { Platform } from "react-native";
// The kav seam, not react-native's: RN's KeyboardAvoidingView measures the
// keyboard against the WINDOW on the JS thread, and inside a native sheet the
// window is not the frame this content lives in — focusing the commit field
// lifted by the wrong amount and a frame late. Every other screen in the app
// already goes through this seam; Changes was the one that did not.
import { KeyboardAvoidingView } from "../components/kav";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useLocalSearchParams, useRouter } from "expo-router";
import { PounceIcon } from "../ui/native/Icon";
import type { IoniconName } from "../ui/native/icon-map";
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
import { INPUT_TWEAKS, IS_DESKTOP, pickSheet } from "../ui";

/** Branches where committing directly is almost never intended. */
const isMainBranch = (b: string | null | undefined) => b === "main" || b === "master";

const NO_SEEN: string[] = [];

/**
 * `embedded` is the desktop's docked pane: the same screen rendered beside a
 * transcript instead of over it, so it drops the sheet's window insets and
 * takes its thread id and dismissal from the shell rather than the router.
 */
export interface ChangesScreenProps {
  embedded?: boolean;
  threadId?: string;
  onClose?: () => void;
}

export default function ChangesScreen({ embedded, threadId, onClose }: ChangesScreenProps = {}) {
  const { id: routeId } = useLocalSearchParams<{ id: string }>();
  const id = threadId ?? routeId;
  const router = useRouter();
  const { theme } = useUnistyles();
  const session = useThread(id);

  const [changes, setChanges] = useState<GitChanges | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<null | "commit" | "push" | "pr">(null);
  // Draft is the default PR mode — the chevron on the button switches it.
  const [prDraft, setPrDraft] = useState(true);
  const [layout, setLayout] = useState<"unified" | "split">("unified");
  const [focused, setFocused] = useState(false);
  // GitHub-style file filter: by extension, via a dropdown with counts.
  const [extFilter, setExtFilter] = useState<string | null>(null);
  // Files marked "Seen" — persisted per thread so they come back collapsed.
  // Stable identities matter: DiffView is memoized because its props cross the
  // WebView bridge, so a fresh [] or closure per keystroke would re-marshal it.
  const seenPaths = useSelector(() => seenFiles$[id!].get()) ?? NO_SEEN;
  const onToggleSeen = useCallback(
    async (path: string, seen: boolean) => setSeenFile(id!, path, seen),
    [id],
  );

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
  // `files` comes from `git status --untracked-files=all`, but the patch and the
  // per-file counts come from `git diff HEAD` — which excludes untracked files.
  // A brand-new checkout is therefore "N files" with an empty patch; listing
  // them beats rendering an empty diff viewer.
  const hasPatch = (changes?.diff ?? "").trim().length > 0;

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
    pickSheet(
      "Filter by file type",
      [`All files (${fileCount})`, ...extensions.map(([ext, n]) => `${ext} (${n})`)],
      (i) => setExtFilter(i === 0 ? null : extensions[i - 1][0]),
    );

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
      ]
        .filter(Boolean)
        .join("\n");
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
      const detail = title
        ? `${title}\n\n${body ?? ""}`.trim()
        : "gh will fill the title/body from commits.";
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

  const pickPrMode = () =>
    pickSheet("Pull request mode", ["Draft PR", "PR"], (i) => setPrDraft(i === 0));

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      // Sheet presentation on mobile: the sheet's top edge already clears the
      // status bar, so window insets would just paint a blank band. The docked
      // pane sits inside the shell's chrome and needs neither.
      style={[s.root, embedded ? s.rootPadEmbedded : s.rootPad]}
    >
      {/* Header. Docked, this is a single line: title and counts side by side,
          dismissal on the right where macOS puts it, and no branch — the shell's
          status bar already spells the branch out in full, where this pane only
          had room to truncate it. Full-screen/mobile keeps the stacked header,
          which has the width for a subtitle and no status bar to defer to. */}
      <View style={s.header}>
        {!embedded ? (
          <Pressable
            onPress={() => (onClose ? onClose() : router.back())}
            style={({ pressed }) => [s.iconBtn, pressed && s.pressed60]}
          >
            <PounceIcon name="chevron-down" size={22} color={theme.colors.fg} />
          </Pressable>
        ) : null}
        <View style={embedded ? s.titleRowCompact : s.titleWrap}>
          <Text style={embedded ? s.titleCompact : s.title}>Changes</Text>
          {embedded ? (
            fileCount > 0 ? (
              <Text numberOfLines={1} style={s.counts}>
                {fileCount} file{fileCount === 1 ? "" : "s"}
                {"  "}
                <Text style={s.diffAdd}>+{totals.add}</Text>{" "}
                <Text style={s.diffDel}>−{totals.del}</Text>
              </Text>
            ) : null
          ) : (
            <View style={s.metaRow}>
              {changes?.branch ? (
                <Text numberOfLines={1} style={s.branch}>
                  ⎇ {changes.branch}
                </Text>
              ) : null}
              {fileCount > 0 ? (
                <Text numberOfLines={1} style={s.counts}>
                  {fileCount} file{fileCount === 1 ? "" : "s"} ·{" "}
                  <Text style={s.diffAdd}>+{totals.add}</Text>{" "}
                  <Text style={s.diffDel}>−{totals.del}</Text>
                </Text>
              ) : null}
            </View>
          )}
        </View>
        {/* Split view needs width the docked pane doesn't have. */}
        {IS_DESKTOP && !embedded && fileCount > 0 ? (
          <View style={s.layoutToggle}>
            {(["unified", "split"] as const).map((l) => (
              <Pressable
                key={l}
                onPress={() => setLayout(l)}
                style={[s.layoutBtn, layout === l && s.layoutBtnActive]}
              >
                <Text style={[s.layoutText, layout === l ? s.fgText : s.faintText]}>
                  {l === "unified" ? "Unified" : "Split"}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        {fileCount > 1 ? (
          <Pressable
            onPress={pickExtFilter}
            style={({ pressed }) => [
              s.filterBtn,
              extFilter ? s.filterActive : s.filterIdle,
              pressed && s.pressed70,
            ]}
          >
            <PounceIcon
              name="filter"
              size={13}
              color={extFilter ? theme.colors.accent : theme.colors.fgMuted}
            />
            <Text style={[s.filterText, extFilter ? s.accentText : s.mutedText]}>
              {extFilter ?? "Filter"}
            </Text>
          </Pressable>
        ) : null}
        <Pressable onPress={load} style={({ pressed }) => [s.iconBtn, pressed && s.pressed60]}>
          <PounceIcon name="refresh" size={16} color={theme.colors.fgMuted} />
        </Pressable>
        {embedded ? (
          <Pressable
            onPress={() => (onClose ? onClose() : router.back())}
            accessibilityLabel="Close changes"
            style={({ pressed }) => [s.iconBtn, pressed && s.pressed60]}
          >
            <PounceIcon name="close" size={16} color={theme.colors.fgMuted} />
          </Pressable>
        ) : null}
      </View>

      {/* Diff */}
      <View style={s.diffWrap}>
        {loading ? (
          <View style={s.center}>
            <ActivityIndicator color={theme.colors.accent} />
          </View>
        ) : fileCount === 0 ? (
          <View style={s.empty}>
            <Text style={s.emptyEmoji}>✨</Text>
            <Text style={s.emptyTitle}>Working tree clean</Text>
            <Text style={s.emptyBody}>No uncommitted changes in this worktree.</Text>
          </View>
        ) : !hasPatch ? (
          <ScrollView contentContainerStyle={s.fileListBody}>
            <Text style={s.fileListNote}>
              New files git isn’t tracking yet — there’s no diff to show until they’re staged.
            </Text>
            {changes?.files.map((file) => (
              <View key={file.path} style={s.fileRow}>
                <PounceIcon name="document-outline" size={13} color={theme.colors.fgFaint} />
                <Text numberOfLines={1} style={s.filePath}>
                  {file.path}
                </Text>
                <Text style={s.fileStatus}>{file.status}</Text>
              </View>
            ))}
          </ScrollView>
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
        <View style={[s.footer, embedded ? s.footerPadEmbedded : s.footerPad]}>
          {/* AppKit draws its focus ring as a square-cornered rect, which leaves
              four gaps around a rounded field — every input in the app turns it
              off (INPUT_TWEAKS) and draws its own focus edge instead. */}
          <TextInput
            {...INPUT_TWEAKS}
            value={message}
            onChangeText={setMessage}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            editable={!busy}
            placeholder="Commit message — leave empty to generate…"
            placeholderTextColor={theme.colors.fgFaint}
            style={[s.input, focused && s.inputFocused]}
            multiline
          />
          <View style={s.actionsRow}>
            <Pressable
              onPress={commit}
              disabled={busy != null}
              style={[s.commitBtn, busy != null && s.opacity40]}
            >
              {busy === "commit" ? (
                <ActivityIndicator color={theme.colors.onAccent} size="small" />
              ) : (
                <Text style={s.commitText}>Commit</Text>
              )}
            </Pressable>
            <SecondaryButton
              label="Push"
              icon="cloud-upload-outline"
              busy={busy === "push"}
              onPress={push}
              disabled={busy != null}
            />
            <View style={s.prGroup}>
              <Pressable
                onPress={openPR}
                disabled={busy != null}
                style={({ pressed }) => [
                  s.prBtn,
                  busy != null && s.opacity50,
                  pressed && s.pressedHover,
                ]}
              >
                {busy === "pr" ? (
                  <ActivityIndicator color={theme.colors.fgMuted} size="small" />
                ) : (
                  <PounceIcon
                    name="git-pull-request-outline"
                    size={15}
                    color={theme.colors.fgMuted}
                  />
                )}
                <Text style={s.btnLabel}>{prDraft ? "Draft PR" : "PR"}</Text>
              </Pressable>
              <Pressable
                onPress={pickPrMode}
                disabled={busy != null}
                style={({ pressed }) => [s.prChevron, pressed && s.pressedHover]}
              >
                <PounceIcon name="chevron-down" size={13} color={theme.colors.fgFaint} />
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
  icon: IoniconName;
  busy: boolean;
  onPress: () => void;
  disabled: boolean;
}) {
  const { theme } = useUnistyles();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [s.secondaryBtn, disabled && s.opacity50, pressed && s.pressedHover]}
    >
      {busy ? (
        <ActivityIndicator color={theme.colors.fgMuted} size="small" />
      ) : (
        <PounceIcon name={icon} size={15} color={theme.colors.fgMuted} />
      )}
      <Text style={s.btnLabel}>{label}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create((theme, rt) => ({
  /** Safe-area padding in the sheet — applied natively, no re-render. */
  /* `embedded` is a prop, so the CHOICE stays at the call site — only the
     values move into the sheet. */
  rootPad: { paddingTop: IS_DESKTOP ? rt.insets.top + 6 : 6 },
  rootPadEmbedded: { paddingTop: 6 },
  footerPad: { paddingBottom: rt.insets.bottom + 8 },
  footerPadEmbedded: { paddingBottom: 10 },
  root: { flex: 1, backgroundColor: theme.colors.bg },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingBottom: 8,
  },
  iconBtn: { height: 36, width: 36, alignItems: "center", justifyContent: "center" },
  pressed60: { opacity: 0.6 },
  pressed70: { opacity: 0.7 },
  titleWrap: { minWidth: 0, flex: 1 },
  title: { fontSize: 17, fontWeight: "600", color: theme.colors.fg },
  titleCompact: { fontSize: 13, fontWeight: "600", color: theme.colors.fg },
  metaRow: { marginTop: 2, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 8 },
  branch: { flexShrink: 1, fontFamily: "JetBrainsMono", fontSize: 12, color: theme.colors.fgFaint },
  counts: { flexShrink: 0, fontSize: 12, color: theme.colors.fgMuted },
  diffAdd: { color: theme.colors.diffAddFg },
  diffDel: { color: theme.colors.diffDelFg },
  layoutToggle: {
    flexDirection: "row",
    overflow: "hidden",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  layoutBtn: { paddingHorizontal: 10, paddingVertical: 4 },
  layoutBtnActive: { backgroundColor: theme.colors.surfaceAlt },
  layoutText: { fontSize: 12, fontWeight: "500" },
  fgText: { color: theme.colors.fg },
  faintText: { color: theme.colors.fgFaint },
  filterBtn: {
    height: 28,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 8,
  },
  filterActive: { borderColor: theme.colors.accent, backgroundColor: theme.colors.accentSoft },
  filterIdle: { borderColor: theme.colors.border, backgroundColor: "transparent" },
  filterText: { fontSize: 12, fontWeight: "500" },
  accentText: { color: theme.colors.accent },
  mutedText: { color: theme.colors.fgMuted },
  // Docked header: title and counts on one baseline instead of stacked.
  titleRowCompact: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  diffWrap: { flex: 1, borderTopWidth: 1, borderColor: theme.colors.border },
  fileListBody: { paddingHorizontal: 12, paddingVertical: 10, gap: 2 },
  fileListNote: {
    marginBottom: 8,
    fontSize: 11.5,
    lineHeight: 16,
    color: theme.colors.fgMuted,
  },
  fileRow: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 3 },
  filePath: {
    flex: 1,
    fontFamily: "JetBrainsMono",
    fontSize: 11,
    color: theme.colors.fg,
  },
  fileStatus: { flexShrink: 0, fontSize: 10.5, color: theme.colors.fgFaint },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 32 },
  emptyEmoji: { fontSize: 40 },
  emptyTitle: {
    marginTop: 12,
    textAlign: "center",
    fontSize: 15,
    fontWeight: "600",
    color: theme.colors.fg,
  },
  emptyBody: { marginTop: 4, textAlign: "center", fontSize: 13, color: theme.colors.fgMuted },
  // Transparent, borderless bar to match the floating-composer look elsewhere.
  footer: {
    paddingHorizontal: 12,
    paddingTop: 8,
  },
  input: {
    maxHeight: 90,
    minHeight: 40,
    borderRadius: 12,
    backgroundColor: theme.colors.surfaceAlt,
    paddingHorizontal: 12,
    // Even top/bottom padding — a lone paddingTop left the first line riding
    // high in the box (textAlignVertical is Android-only, so symmetric padding
    // is what centres a multiline field).
    paddingVertical: 10,
    fontSize: 14,
    lineHeight: 18,
    color: theme.colors.fg,
    // Border always present so focusing doesn't reflow the field by 1px.
    borderWidth: 1,
    borderColor: "transparent",
  },
  inputFocused: { borderColor: theme.colors.accent },
  actionsRow: { marginTop: 8, flexDirection: "row", gap: 8 },
  commitBtn: {
    height: 36,
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 12,
    backgroundColor: theme.colors.accent,
  },
  opacity40: { opacity: 0.4 },
  opacity50: { opacity: 0.5 },
  commitText: { fontSize: 13, fontWeight: "600", color: theme.colors.onAccent },
  prGroup: {
    flex: 1,
    flexDirection: "row",
    overflow: "hidden",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
  prBtn: {
    height: 36,
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  prChevron: {
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    borderLeftWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: 8,
  },
  pressedHover: { backgroundColor: theme.colors.surfaceHover },
  btnLabel: { fontSize: 13, fontWeight: "500", color: theme.colors.fgMuted },
  secondaryBtn: {
    height: 36,
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
}));
