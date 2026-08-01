/**
 * A project's agent instructions — CLAUDE.md, AGENTS.md and friends — read and
 * edited in place, on every platform.
 *
 * These files were read-only at first, on the reasoning that a repo change
 * should land through an agent turn where git shows a diff. What changed is
 * that they're prose the user WRITES: fixing a stale build command by dictating
 * it to an agent is ceremony, not safety. So this edits directly — and keeps
 * the agent route beside it ("Ask an agent"), because "rewrite this section to
 * match how we actually test" is still a job for an agent, not a typing
 * exercise.
 *
 * Two writers share one file, so every save carries the mtime it was read at.
 * If an agent edited the file while this editor was open, the save is refused
 * and the user chooses: take theirs, or overwrite with mine.
 *
 * Rendering and editing both go through platform seams — MessageMarkdown and
 * MarkdownEditor — because the phones have a native markdown engine and
 * desktop doesn't (see MarkdownEditor.desktop).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useRouter } from "expo-router";
import { PounceIcon } from "../ui/native/Icon";
import { MessageMarkdown } from "./MessageMarkdown";
import { MarkdownEditor } from "./MarkdownEditor";
import { saveContextFile, type ContextFile } from "../services/bridge";
import { contextDraft$ } from "../state/contextComments";
import { IS_DESKTOP } from "../ui";

/** The files a project can have, in the order they're offered when it has none.
 *  CLAUDE.md leads because Claude is the default agent; AGENTS.md is the
 *  cross-agent convention and the nested form is Claude Code's own. */
const CREATABLE = ["CLAUDE.md", "AGENTS.md", ".claude/CLAUDE.md"] as const;

/** Starter text for a file being created, so the editor doesn't open on a void.
 *  Deliberately headings-and-prompts rather than filled-in advice: a template
 *  full of plausible defaults gets committed unread. */
function starter(name: string, project: string): string {
  return [
    `# ${project}`,
    "",
    "## Build and test",
    "",
    "<!-- The commands an agent should run here. -->",
    "",
    "## House style",
    "",
    "<!-- Conventions that aren't obvious from the code. -->",
    "",
    "## Gotchas",
    "",
    `<!-- What trips people up. (${name}) -->`,
    "",
  ].join("\n");
}

type Conflict = { mtime: string | null };

export function ContextEditor({
  hostId,
  cwd,
  project,
  repoId,
  files,
  loading,
  unreachable,
  onReload,
  onSaved,
}: {
  hostId: string;
  cwd: string;
  /** Display name, used for the starter file's title. */
  project: string;
  repoId: string;
  files: ContextFile[];
  loading: boolean;
  /** The host didn't answer at all — different from "answered, no files". */
  unreachable: boolean;
  onReload: () => void;
  /** A file was written; the parent refreshes its copy from this. */
  onSaved: (file: ContextFile) => void;
}) {
  const router = useRouter();
  const { theme } = useUnistyles();
  const [active, setActive] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  /** The mtime the draft was based on — `null` while creating a new file, which
   *  asserts to the host that nothing should be there yet. */
  const baseMtime = useRef<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Files being created don't exist on the host yet, so they aren't in `files`
   *  — track the name separately or the tab strip loses it mid-edit. */
  const [creating, setCreating] = useState<string | null>(null);

  const file = useMemo(() => files.find((f) => f.path === active) ?? null, [files, active]);
  const editing = draft !== null;

  // Follow the host's list when it changes under us, but never yank the file
  // out from under an open editor.
  useEffect(() => {
    if (editing) return;
    setActive((cur) => (cur && files.some((f) => f.path === cur) ? cur : (files[0]?.path ?? null)));
  }, [files, editing]);

  const startEdit = useCallback(() => {
    if (!file || file.truncated) return; // truncated content is a PREFIX — saving it would delete the tail
    baseMtime.current = file.mtime;
    setCreating(null);
    setConflict(null);
    setError(null);
    setDraft(file.content);
  }, [file]);

  const startCreate = useCallback(
    (name: string) => {
      baseMtime.current = null;
      setCreating(name);
      setActive(name);
      setConflict(null);
      setError(null);
      setDraft(starter(name, project));
    },
    [project],
  );

  const cancel = useCallback(() => {
    setDraft(null);
    setCreating(null);
    setConflict(null);
    setError(null);
  }, []);

  const save = useCallback(
    async (force = false) => {
      const path = creating ?? file?.path;
      if (draft === null || !path) return;
      setSaving(true);
      setError(null);
      const out = await saveContextFile(
        hostId,
        cwd,
        path,
        draft,
        force ? undefined : baseMtime.current,
      );
      setSaving(false);
      if (out.ok) {
        onSaved(out.file);
        setActive(out.file.path);
        setDraft(null);
        setCreating(null);
        setConflict(null);
        return;
      }
      if (out.conflict) setConflict({ mtime: out.mtime });
      else setError(out.error);
    },
    [creating, file, draft, hostId, cwd, onSaved],
  );

  /** Hand the file to an agent instead — kept because some changes are a
   *  request, not an edit. Seeds the composer and opens it. */
  const askAgent = useCallback(() => {
    const name = file?.path ?? creating ?? CREATABLE[0];
    contextDraft$.set(`Update \`${name}\` in ${cwd}.\n\nWhat should change:\n- `);
    router.push({ pathname: "/new", params: { cwd, hostId, repoId } });
  }, [file, creating, cwd, hostId, repoId, router]);

  const tabs = useMemo(() => {
    const names = files.map((f) => f.path);
    return creating && !names.includes(creating) ? [...names, creating] : names;
  }, [files, creating]);

  if (loading) {
    return (
      <View style={s.centered}>
        <ActivityIndicator color={theme.colors.fgMuted} />
      </View>
    );
  }

  if (unreachable) {
    return (
      <View style={s.centered}>
        <PounceIcon name="cloud-offline-outline" size={28} color={theme.colors.fgFaint} />
        <Text style={s.emptyTitle}>Can&apos;t reach this machine</Text>
        <Text style={s.emptyBody}>
          The bridge didn&apos;t answer. It may be offline, or running a version without project
          context.
        </Text>
        <Pressable onPress={onReload} style={({ pressed }) => [s.btn, pressed && s.pressed]}>
          <Text style={s.btnLabel}>Try again</Text>
        </Pressable>
      </View>
    );
  }

  if (!files.length && !creating) {
    return (
      <View style={s.centered}>
        <PounceIcon name="document-text-outline" size={28} color={theme.colors.fgFaint} />
        <Text style={s.emptyTitle}>No instructions yet</Text>
        <Text style={s.emptyBody}>
          Nothing here tells an agent how to work in this project — what to build with, how to test,
          what to leave alone.
        </Text>
        <View style={s.createRow}>
          {CREATABLE.map((name) => (
            <Pressable
              key={name}
              onPress={() => startCreate(name)}
              style={({ pressed }) => [s.btn, pressed && s.pressed]}
            >
              <PounceIcon name="add-circle" size={14} color={theme.colors.fgMuted} />
              <Text style={s.btnLabel}>{name}</Text>
            </Pressable>
          ))}
        </View>
        <Pressable onPress={askAgent} style={({ pressed }) => [s.linkBtn, pressed && s.pressed]}>
          <PounceIcon name="sparkles" size={13} color={theme.colors.accent} />
          <Text style={s.linkLabel}>Have an agent draft one</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View>
      <View style={s.toolbar}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.tabScroll}>
          <View style={s.tabRow}>
            {tabs.map((path) => {
              const on = path === active;
              return (
                <Pressable
                  key={path}
                  // Switching files mid-edit would drop the draft silently.
                  disabled={editing && !on}
                  onPress={() => setActive(path)}
                  style={({ pressed }) => [
                    s.tab,
                    on ? s.tabOn : pressed && s.tabPressed,
                    editing && !on && s.tabDim,
                  ]}
                >
                  <Text style={[s.tabLabel, on && s.tabLabelOn]}>{path}</Text>
                  {path === creating ? <Text style={s.tabBadge}>new</Text> : null}
                </Pressable>
              );
            })}
          </View>
        </ScrollView>
        <View style={s.flex1} />
        {editing ? (
          <>
            <Pressable
              onPress={cancel}
              disabled={saving}
              style={({ pressed }) => [s.btn, pressed && s.pressed]}
            >
              <Text style={s.btnLabel}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={() => void save()}
              disabled={saving}
              style={({ pressed }) => [s.btn, s.btnPrimary, pressed && s.pressed]}
            >
              {saving ? (
                <ActivityIndicator size="small" color={theme.colors.onAccent} />
              ) : (
                <PounceIcon name="checkmark-circle" size={14} color={theme.colors.onAccent} />
              )}
              <Text style={[s.btnLabel, s.btnPrimaryLabel]}>Save</Text>
            </Pressable>
          </>
        ) : (
          <>
            <Pressable onPress={askAgent} style={({ pressed }) => [s.btn, pressed && s.pressed]}>
              <PounceIcon name="sparkles" size={14} color={theme.colors.accent} />
              <Text style={s.btnLabel}>Ask an agent</Text>
            </Pressable>
            <Pressable
              onPress={startEdit}
              disabled={!file || file.truncated}
              style={({ pressed }) => [
                s.btn,
                pressed && s.pressed,
                (!file || file.truncated) && s.btnDisabled,
              ]}
            >
              <PounceIcon name="create-outline" size={14} color={theme.colors.fgMuted} />
              <Text style={s.btnLabel}>Edit</Text>
            </Pressable>
          </>
        )}
      </View>

      {conflict ? (
        <View style={[s.banner, s.bannerWarn]}>
          <PounceIcon name="alert-circle" size={14} color={theme.colors.warning} />
          <Text style={s.bannerText}>
            This file changed on disk since you opened it
            {conflict.mtime ? " — an agent may have edited it." : "."}
          </Text>
          <Pressable
            onPress={() => {
              cancel();
              onReload();
            }}
            style={({ pressed }) => [s.bannerBtn, pressed && s.pressed]}
          >
            <Text style={s.bannerBtnLabel}>Discard mine</Text>
          </Pressable>
          <Pressable
            onPress={() => void save(true)}
            style={({ pressed }) => [s.bannerBtn, s.bannerBtnStrong, pressed && s.pressed]}
          >
            <Text style={[s.bannerBtnLabel, s.bannerBtnStrongLabel]}>Overwrite</Text>
          </Pressable>
        </View>
      ) : null}

      {error ? (
        <View style={[s.banner, s.bannerDanger]}>
          <PounceIcon name="alert-circle" size={14} color={theme.colors.danger} />
          <Text style={s.bannerText}>{error}</Text>
        </View>
      ) : null}

      {file?.truncated && !editing ? (
        <View style={[s.banner, s.bannerWarn]}>
          <PounceIcon name="alert-circle" size={14} color={theme.colors.warning} />
          <Text style={s.bannerText}>
            Showing the first {Math.round(file.content.length / 1024)}KB of{" "}
            {Math.round(file.size / 1024)}KB — too long to edit here without losing the rest.
          </Text>
        </View>
      ) : null}

      {editing ? (
        // Remounts per file (and per version) because the editor is
        // uncontrolled on both platforms — see MarkdownEditor.types.
        <MarkdownEditor
          key={`${creating ?? file?.path}:${baseMtime.current ?? "new"}`}
          defaultValue={draft}
          onChangeText={setDraft}
          autoFocus
          placeholder="What should an agent know about this project?"
        />
      ) : (
        // Rendered, not raw. `singleBlock` keeps fenced code inline rather than
        // lifting it into sibling Run cards — right for a document you're
        // reading rather than a turn you're replaying. Deliberately not wrapped
        // in a ScrollView: the page owns scrolling, and a nested one would eat
        // the gesture and pin the page in place.
        <View style={s.reader}>
          <MessageMarkdown text={file?.content ?? ""} role="assistant" singleBlock />
        </View>
      )}

      {file && !editing ? (
        <Text style={s.footNote}>
          {(file.size / 1024).toFixed(1)}KB · saved {new Date(file.mtime).toLocaleString()}
        </Text>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create((theme) => ({
  flex1: { flex: 1 },
  pressed: { opacity: 0.6 },
  centered: { alignItems: "center", justifyContent: "center", gap: 9, paddingVertical: 44 },
  emptyTitle: { fontSize: IS_DESKTOP ? 14 : 16, fontWeight: "600", color: theme.colors.fg },
  emptyBody: {
    maxWidth: 400,
    textAlign: "center",
    fontSize: IS_DESKTOP ? 12.5 : 14,
    lineHeight: IS_DESKTOP ? 18 : 20,
    color: theme.colors.fgMuted,
  },
  createRow: {
    marginTop: 4,
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: 7,
  },

  toolbar: { flexDirection: "row", alignItems: "center", gap: 7, paddingBottom: 9 },
  tabScroll: { flexGrow: 0 },
  tabRow: { flexDirection: "row", gap: 5 },
  tab: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    borderRadius: 7,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  tabOn: { backgroundColor: theme.colors.surfaceHover },
  tabPressed: { backgroundColor: theme.colors.surface },
  tabDim: { opacity: 0.4 },
  tabLabel: { fontFamily: "JetBrainsMono", fontSize: 11.5, color: theme.colors.fgMuted },
  tabLabelOn: { color: theme.colors.fg },
  tabBadge: { fontSize: 9.5, fontWeight: "600", color: theme.colors.accent },

  btn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  btnPrimary: { borderColor: theme.colors.accent, backgroundColor: theme.colors.accent },
  btnPrimaryLabel: { color: theme.colors.onAccent },
  btnDisabled: { opacity: 0.4 },
  btnLabel: { fontSize: 12, fontWeight: "500", color: theme.colors.fgMuted },
  linkBtn: { marginTop: 2, flexDirection: "row", alignItems: "center", gap: 5 },
  linkLabel: { fontSize: 12.5, fontWeight: "500", color: theme.colors.accent },

  banner: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 7,
    marginBottom: 9,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  bannerWarn: { borderColor: theme.colors.warning, backgroundColor: theme.colors.warningSoft },
  bannerDanger: { borderColor: theme.colors.danger, backgroundColor: theme.colors.dangerSoft },
  bannerText: { flex: 1, minWidth: 180, fontSize: 12, lineHeight: 17, color: theme.colors.fg },
  bannerBtn: {
    borderRadius: 7,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  bannerBtnStrong: { borderColor: theme.colors.danger, backgroundColor: theme.colors.danger },
  bannerBtnLabel: { fontSize: 11.5, fontWeight: "500", color: theme.colors.fgMuted },
  bannerBtnStrongLabel: { color: theme.colors.onAccent },

  reader: { paddingBottom: 4 },
  footNote: { paddingTop: 7, fontSize: 11, color: theme.colors.fgFaint },
}));
