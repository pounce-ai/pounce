import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSelector } from "@legendapp/state/react";
import { PounceIcon } from "../ui/native/Icon";
import { fetchContextFiles, type ContextFile } from "../services/bridge";
import { MessageMarkdown } from "../components/MessageMarkdown";
import { NativeSheet } from "../components/NativeSheet";
import {
  buildContextChangeRequest,
  findMatches,
  QUOTE_MAX,
  sectionForText,
  splitHighlight,
  splitSections,
} from "../components/contextSections";
import {
  addContextComment,
  clearContextComments,
  contextComments$,
  contextDraft$,
  contextKey,
  removeContextComment,
  type ContextComment,
} from "../state/contextComments";
import { useThreads } from "../state/db/hooks";
import { INPUT_TWEAKS, IS_DESKTOP } from "../ui";

/** The file the app offers to create when a project has no context at all.
 *  CLAUDE.md and AGENTS.md are both conventions; this picks the one Claude
 *  Code reads, since Claude is the default agent. */
const DEFAULT_CONTEXT_FILE = "CLAUDE.md";

const HIGHLIGHT = "#B3E561";
const HIGHLIGHT_BG = "rgba(179, 229, 97, 0.22)";

const NO_COMMENTS: ContextComment[] = [];

/** What the comment sheet is currently about. */
type Draft =
  | { kind: "selection"; quote: string; heading: string | null }
  | { kind: "file" }
  | { kind: "create" };

/**
 * A project's agent-context files — CLAUDE.md, AGENTS.md — read, searched, and
 * commented on.
 *
 * Read-only by design. Editing these from a phone would be a repo change with
 * no diff and no review; instead the user highlights a passage, says what's
 * wrong with it, and hands the notes to an agent as a new task — where the edit
 * lands in git like any other.
 *
 * The file renders as ONE markdown document, not a stack of per-section cards:
 * a text selection can't cross two sibling views, and selecting the passage you
 * mean is the whole interaction.
 */
export default function ContextScreen() {
  const params = useLocalSearchParams<{ repoId?: string; hostId?: string; cwd?: string }>();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { theme } = useUnistyles();
  const { height } = useWindowDimensions();
  const threads = useThreads();

  // Where to read from. An explicit cwd+host wins (opened from a session);
  // otherwise resolve the repo's directories from its threads. A repo can have
  // several — worktrees — so they become a chip switcher, root preferred.
  const candidates = useMemo(() => {
    if (params.cwd && params.hostId)
      return [{ cwd: String(params.cwd), hostId: String(params.hostId) }];
    if (!params.repoId) return [];
    const seen = new Set<string>();
    return threads
      .filter((t) => t.repoId === params.repoId && t.cwd)
      .sort((a, b) => {
        // Repo root before worktrees: it's where the committed context lives.
        if (!!a.worktree !== !!b.worktree) return a.worktree ? 1 : -1;
        return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
      })
      .filter((t) => {
        const key = `${t.hostId}|${t.cwd}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((t) => ({ cwd: t.cwd as string, hostId: t.hostId }));
  }, [params.cwd, params.hostId, params.repoId, threads]);

  const [pick, setPick] = useState(0);
  const target = candidates[Math.min(pick, candidates.length - 1)] ?? null;

  const [files, setFiles] = useState<ContextFile[] | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [note, setNote] = useState("");
  const [showNotes, setShowNotes] = useState(false);

  const commentKey = target ? contextKey(target.hostId, target.cwd) : "";
  const comments = useSelector(() => contextComments$[commentKey].get()) ?? NO_COMMENTS;

  const load = useCallback(async () => {
    if (!target) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const out = await fetchContextFiles(target.hostId, target.cwd);
    setUnreachable(out === null);
    setFiles(out?.files ?? []);
    setActiveFile((cur) => {
      if (cur && out?.files.some((f) => f.path === cur)) return cur;
      return out?.files[0]?.path ?? null;
    });
    setLoading(false);
  }, [target]);

  useEffect(() => {
    void load();
  }, [load]);

  const file = useMemo(
    () => files?.find((f) => f.path === activeFile) ?? null,
    [files, activeFile],
  );
  // Sections aren't rendered as separate views any more — they exist so a
  // selection can be labelled with the heading it came from, and so search can
  // narrow the document to the parts that matched.
  const sections = useMemo(() => (file ? splitSections(file.content, file.path) : []), [file]);
  const hits = useMemo(() => findMatches(sections, query), [sections, query]);
  const searching = query.trim().length > 0;

  /** Open the comment sheet for a text selection. */
  const commentOnSelection = useCallback(
    (selected: string) => {
      const trimmed = selected.trim();
      if (!trimmed) return;
      const section = sectionForText(sections, trimmed);
      setDraft({
        kind: "selection",
        quote: trimmed.length > QUOTE_MAX ? trimmed.slice(0, QUOTE_MAX) + "…" : trimmed,
        heading: section?.heading ?? null,
      });
      setNote("");
    },
    [sections],
  );

  // The native selection menu's extra action — the "select text → Comment"
  // gesture. Rebuilt when the sections change so the handler labels the
  // selection against the file actually on screen.
  const menuItems = useMemo(
    () => [{ text: "Comment", onPress: (e: { text: string }) => commentOnSelection(e.text) }],
    [commentOnSelection],
  );

  const submitComment = () => {
    if (!target || !draft || !note.trim()) return;
    const base = { note: note.trim() };
    if (draft.kind === "create") {
      addContextComment(target.hostId, target.cwd, {
        ...base,
        file: DEFAULT_CONTEXT_FILE,
        heading: null,
        quote: "",
        missing: true,
      });
    } else if (file) {
      addContextComment(target.hostId, target.cwd, {
        ...base,
        file: file.path,
        heading: draft.kind === "selection" ? draft.heading : null,
        quote: draft.kind === "selection" ? draft.quote : "",
      });
    }
    setNote("");
    setDraft(null);
  };

  const requestChanges = () => {
    if (!target || !comments.length) return;
    contextDraft$.set(buildContextChangeRequest({ cwd: target.cwd, comments }));
    clearContextComments(target.hostId, target.cwd);
    router.replace({
      pathname: "/new",
      params: {
        cwd: target.cwd,
        hostId: target.hostId,
        ...(params.repoId ? { repoId: String(params.repoId) } : {}),
      },
    });
  };

  return (
    <View style={[s.root, IS_DESKTOP ? { paddingTop: insets.top + 8 } : null]}>
      {IS_DESKTOP ? (
        <View style={s.headerRow}>
          <Text style={s.headerTitle}>Project context</Text>
          <Pressable onPress={() => router.back()} style={({ pressed }) => pressed && s.pressed60}>
            <Text style={s.cancelLabel}>Close</Text>
          </Pressable>
        </View>
      ) : null}

      {target ? (
        <Text numberOfLines={1} style={s.cwdLine}>
          {target.cwd}
        </Text>
      ) : null}

      {candidates.length > 1 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.chipScroll}>
          <View style={s.chipRow}>
            {candidates.map((c, i) => (
              <Pressable
                key={`${c.hostId}|${c.cwd}`}
                onPress={() => setPick(i)}
                style={[s.chip, i === pick ? s.chipActive : s.chipIdle]}
              >
                <Text style={[s.chipText, i === pick ? s.accentText : s.mutedText]}>
                  {c.cwd.split("/").pop() || c.cwd}
                </Text>
              </Pressable>
            ))}
          </View>
        </ScrollView>
      ) : null}

      {files && files.length > 1 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.chipScroll}>
          <View style={s.chipRow}>
            {files.map((f) => {
              const active = f.path === activeFile;
              const n = comments.filter((c) => c.file === f.path).length;
              return (
                <Pressable
                  key={f.path}
                  onPress={() => setActiveFile(f.path)}
                  style={[s.chip, active ? s.chipActive : s.chipIdle]}
                >
                  <Text style={[s.chipText, active ? s.accentText : s.mutedText]}>
                    {f.path}
                    {n ? ` · ${n}` : ""}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </ScrollView>
      ) : null}

      {file ? (
        <View style={s.toolbar}>
          <View style={s.searchRow}>
            <PounceIcon name="search" size={15} color={theme.colors.fgFaint} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder={`Search ${file.name}…`}
              placeholderTextColor={theme.colors.fgFaint}
              autoCapitalize="none"
              autoCorrect={false}
              style={s.searchInput}
              {...INPUT_TWEAKS}
            />
            {searching ? (
              <>
                <Text style={s.hitCount}>{hits.length}</Text>
                <Pressable onPress={() => setQuery("")} hitSlop={8}>
                  <PounceIcon name="close" size={16} color={theme.colors.fgFaint} />
                </Pressable>
              </>
            ) : null}
          </View>
          {/* Always-available path to a note. Selecting text is the good way in,
              but it isn't discoverable on its own and desktop's renderer has no
              selection menu at all. */}
          <Pressable
            onPress={() => {
              setDraft({ kind: "file" });
              setNote("");
            }}
            hitSlop={8}
            style={({ pressed }) => [s.iconBtn, pressed && s.pressed60]}
          >
            <PounceIcon name="chatbubble-ellipses-outline" size={17} color={theme.colors.fgMuted} />
          </Pressable>
        </View>
      ) : null}

      <ScrollView
        style={s.scroll}
        contentContainerStyle={[s.scrollContent, { paddingBottom: insets.bottom + 110 }]}
      >
        {loading ? (
          <ActivityIndicator style={s.spinner} color={theme.colors.fgMuted} />
        ) : !target ? (
          <Empty
            icon="folder-open-outline"
            title="No folder to read"
            body="Open this from a thread with a working directory."
          />
        ) : unreachable ? (
          <Empty
            icon="cloud-offline-outline"
            title="Can't reach this machine"
            body="The bridge didn't answer. It may be offline, or running a version without project context."
            action={{ label: "Try again", onPress: () => void load() }}
          />
        ) : !files?.length ? (
          <Empty
            icon="document-text-outline"
            title="No context files yet"
            body={`Nothing here tells an agent how to work in this project. Ask one to write a ${DEFAULT_CONTEXT_FILE}.`}
            action={{
              label: `Draft a ${DEFAULT_CONTEXT_FILE}`,
              onPress: () => {
                setDraft({ kind: "create" });
                setNote("");
              },
            }}
          />
        ) : file ? (
          <>
            {file.truncated ? (
              <Text style={s.truncated}>
                Showing the first {Math.round(file.content.length / 1024)}KB of{" "}
                {Math.round(file.size / 1024)}KB.
              </Text>
            ) : null}

            {searching ? (
              // Search narrows the document to the parts that matched rather
              // than jumping a cursor through it — on a phone, "here are the 3
              // places" beats "match 1 of 7, keep tapping". These render as
              // plain text because the native engine draws a block at a time
              // and can't tint a substring inside one.
              hits.length ? (
                hits.map(({ section, count }) => (
                  <View key={section.id} style={s.hitBlock}>
                    {section.heading ? (
                      <Text style={s.hitHeading}>
                        {section.heading}
                        <Text style={s.hitCountInline}>
                          {"  "}
                          {count}
                        </Text>
                      </Text>
                    ) : null}
                    <Text style={s.rawText} selectable>
                      {splitHighlight(section.body, query).map((part, i) => (
                        <Text key={i} style={part.match ? s.rawMatch : undefined}>
                          {part.text}
                        </Text>
                      ))}
                    </Text>
                  </View>
                ))
              ) : (
                <Text style={s.noHits}>No matches in {file.name}.</Text>
              )
            ) : (
              // The whole file, one markdown view. `singleBlock` keeps fenced
              // code inside it instead of lifting it into sibling cards, so a
              // selection can run the length of the document.
              <MessageMarkdown
                text={file.content}
                role="assistant"
                singleBlock
                contextMenuItems={menuItems}
              />
            )}
          </>
        ) : null}
      </ScrollView>

      {comments.length ? (
        <View style={[s.footer, { paddingBottom: insets.bottom + 12 }]}>
          <Pressable onPress={() => setShowNotes((v) => !v)} style={s.notesToggle} hitSlop={6}>
            <PounceIcon
              name={showNotes ? "chevron-down" : "chevron-up"}
              size={14}
              color={theme.colors.fgMuted}
            />
            <Text style={s.notesToggleText}>
              {comments.length} note{comments.length === 1 ? "" : "s"}
            </Text>
          </Pressable>
          {showNotes ? (
            <ScrollView style={{ maxHeight: height * 0.3 }} contentContainerStyle={s.notesList}>
              {comments.map((c) => (
                <View key={c.id} style={s.note}>
                  <View style={s.flex1}>
                    <Text style={s.noteWhere}>
                      {c.file}
                      {c.heading ? ` · ${c.heading}` : ""}
                    </Text>
                    {c.quote ? (
                      <Text numberOfLines={2} style={s.noteQuote}>
                        {c.quote}
                      </Text>
                    ) : null}
                    <Text style={s.noteText}>{c.note}</Text>
                  </View>
                  <Pressable
                    onPress={() => target && removeContextComment(target.hostId, target.cwd, c.id)}
                    hitSlop={8}
                  >
                    <PounceIcon name="close" size={14} color={theme.colors.fgFaint} />
                  </Pressable>
                </View>
              ))}
            </ScrollView>
          ) : null}
          <Pressable
            onPress={requestChanges}
            style={({ pressed }) => [s.cta, pressed && s.pressed80]}
          >
            <PounceIcon name="sparkles" size={15} color={theme.colors.onAccent} />
            <Text style={s.ctaText}>
              Request {comments.length} change{comments.length === 1 ? "" : "s"}
            </Text>
          </Pressable>
          <Text style={s.footerHint}>
            Opens a new task with your notes — the agent makes the edits.
          </Text>
        </View>
      ) : file && !searching ? (
        <Text style={[s.selectHint, { paddingBottom: insets.bottom + 10 }]}>
          {IS_DESKTOP
            ? "Tap the speech bubble to leave a note for the agent."
            : "Select any text to comment on it."}
        </Text>
      ) : null}

      <NativeSheet visible={!!draft} onClose={() => setDraft(null)}>
        {/* Only the quote scrolls; the action sits below it. A long selection
            must not push the button out of reach. */}
        <ScrollView bounces={false} style={{ maxHeight: height * 0.45 }}>
          <Text style={s.sheetTitle}>
            {draft?.kind === "create"
              ? `New ${DEFAULT_CONTEXT_FILE}`
              : draft?.kind === "selection"
                ? (draft.heading ?? file?.name ?? "Comment")
                : (file?.name ?? "Comment")}
          </Text>
          {draft?.kind === "create" ? (
            <Text style={s.sheetBlurb}>
              Describe what this project&apos;s agents need to know — build and test commands, house
              style, anything that trips people up.
            </Text>
          ) : draft?.kind === "selection" ? (
            <Text numberOfLines={8} style={s.sheetQuote}>
              {draft.quote}
            </Text>
          ) : (
            <Text style={s.sheetBlurb}>A note about this file as a whole.</Text>
          )}
          <TextInput
            value={note}
            onChangeText={setNote}
            placeholder="What should change here?"
            placeholderTextColor={theme.colors.fgFaint}
            multiline
            autoFocus
            style={s.noteInput}
            {...INPUT_TWEAKS}
          />
        </ScrollView>
        <Pressable
          onPress={submitComment}
          disabled={!note.trim()}
          style={({ pressed }) => [
            s.cta,
            s.sheetCta,
            !note.trim() && s.ctaDisabled,
            pressed && s.pressed80,
          ]}
        >
          <Text style={s.ctaText}>Add note</Text>
        </Pressable>
      </NativeSheet>
    </View>
  );
}

function Empty({
  icon,
  title,
  body,
  action,
}: {
  icon: "folder-open-outline" | "cloud-offline-outline" | "document-text-outline";
  title: string;
  body: string;
  action?: { label: string; onPress: () => void };
}) {
  const { theme } = useUnistyles();
  return (
    <View style={s.empty}>
      <PounceIcon name={icon} size={34} color={theme.colors.fgFaint} />
      <Text style={s.emptyTitle}>{title}</Text>
      <Text style={s.emptyBody}>{body}</Text>
      {action ? (
        <Pressable
          onPress={action.onPress}
          style={({ pressed }) => [s.cta, pressed && s.pressed80]}
        >
          <Text style={s.ctaText}>{action.label}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.bg },
  flex1: { flex: 1 },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  headerTitle: { fontSize: 22, fontWeight: "700", color: theme.colors.fg },
  cancelLabel: { fontSize: 15, color: theme.colors.fgMuted },
  cwdLine: {
    paddingHorizontal: 16,
    paddingTop: 8,
    fontFamily: "JetBrainsMono",
    fontSize: 11,
    color: theme.colors.fgFaint,
  },
  chipScroll: { flexGrow: 0, paddingTop: 10 },
  chipRow: { flexDirection: "row", gap: 8, paddingHorizontal: 16 },
  chip: { borderRadius: 999, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 5 },
  chipActive: { borderColor: theme.colors.accent, backgroundColor: theme.colors.accentSoft },
  chipIdle: { borderColor: theme.colors.border, backgroundColor: theme.colors.surface },
  chipText: { fontSize: 12 },
  accentText: { color: theme.colors.accent },
  mutedText: { color: theme.colors.fgMuted },
  toolbar: {
    marginHorizontal: 16,
    marginTop: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  searchRow: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  searchInput: { flex: 1, fontSize: 14, color: theme.colors.fg },
  hitCount: { fontFamily: "JetBrainsMono", fontSize: 11, color: theme.colors.fgFaint },
  iconBtn: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  scroll: { flex: 1 },
  scrollContent: { gap: 12, paddingHorizontal: 16, paddingTop: 14 },
  spinner: { paddingTop: 40 },
  truncated: { fontSize: 12, color: theme.colors.warning },
  hitBlock: {
    gap: 6,
    borderLeftWidth: 2,
    borderLeftColor: HIGHLIGHT,
    paddingLeft: 12,
  },
  hitHeading: { fontSize: 15, fontWeight: "700", color: theme.colors.fg },
  hitCountInline: { fontSize: 12, fontWeight: "500", color: theme.colors.fgFaint },
  rawText: { fontSize: 14, lineHeight: 21, color: theme.colors.fgMuted },
  rawMatch: { backgroundColor: HIGHLIGHT_BG, color: HIGHLIGHT },
  noHits: { paddingTop: 24, textAlign: "center", fontSize: 13, color: theme.colors.fgMuted },
  selectHint: {
    textAlign: "center",
    paddingHorizontal: 16,
    paddingTop: 8,
    fontSize: 11,
    color: theme.colors.fgFaint,
  },
  footer: {
    gap: 8,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.bgElevated,
    paddingHorizontal: 16,
    paddingTop: 10,
  },
  notesToggle: { flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "center" },
  notesToggleText: { fontSize: 12, color: theme.colors.fgMuted },
  notesList: { gap: 8 },
  note: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    borderRadius: 10,
    backgroundColor: theme.colors.surfaceAlt,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  noteWhere: { fontSize: 10, fontWeight: "600", color: theme.colors.fgFaint },
  noteQuote: {
    marginTop: 2,
    borderLeftWidth: 2,
    borderLeftColor: theme.colors.border,
    paddingLeft: 6,
    fontSize: 12,
    color: theme.colors.fgMuted,
  },
  noteText: { marginTop: 4, fontSize: 13, color: theme.colors.fg },
  cta: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderRadius: 12,
    backgroundColor: theme.colors.accent,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  ctaDisabled: { opacity: 0.4 },
  ctaText: { fontSize: 15, fontWeight: "600", color: theme.colors.onAccent },
  footerHint: { textAlign: "center", fontSize: 11, color: theme.colors.fgFaint },
  empty: { alignItems: "center", gap: 10, paddingHorizontal: 24, paddingTop: 48 },
  emptyTitle: { fontSize: 16, fontWeight: "600", color: theme.colors.fg },
  emptyBody: { textAlign: "center", fontSize: 13, lineHeight: 19, color: theme.colors.fgMuted },
  sheetTitle: { fontSize: 17, fontWeight: "600", color: theme.colors.fg },
  sheetBlurb: { marginTop: 8, fontSize: 13, lineHeight: 19, color: theme.colors.fgMuted },
  sheetQuote: {
    marginTop: 8,
    borderLeftWidth: 2,
    borderLeftColor: HIGHLIGHT,
    paddingLeft: 10,
    fontSize: 13,
    lineHeight: 19,
    color: theme.colors.fgMuted,
  },
  noteInput: {
    marginTop: 12,
    minHeight: 88,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    padding: 12,
    fontSize: 14,
    color: theme.colors.fg,
    textAlignVertical: "top",
  },
  sheetCta: { marginTop: 12 },
  pressed60: { opacity: 0.6 },
  pressed80: { opacity: 0.8 },
}));
