import { type Ref, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import {
  ActionSheetIOS,
  Alert,
  Image,
  Keyboard,
  Pressable,
  Text,
  useColorScheme,
  View,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import {
  EnrichedMarkdownTextInput,
  type EnrichedMarkdownTextInputInstance,
  type MarkdownTextInputStyle,
} from "./enrichedInput";
import {
  Animated,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from "./animation";
import { GlassCard } from "../ui/native/GlassCard";
import { PounceIcon } from "../ui/native/Icon";
import type { IoniconName } from "../ui/native/icon-map";
import type { AgentCapabilities, RunImage } from "@pounce/shared";
import { SLASH_COMMANDS } from "../ui/agent-meta";
import { fetchFiles, type RepoEntry, type ThreadUsage } from "../services/bridge";
import { ContextRing } from "./ContextRing";
import { isVoiceAvailable, startDictation, type Dictation } from "../services/voice";
import { AgentLogo, COLOR } from "../ui";
import { hexFor } from "../ui/theme-hex";

const MENTION_RE = /((?:^|\s))@([^\s@]*)$/;

/** The daemon has no document channel, so a text file is embedded inline in the
 *  message. Cap the inline size — bigger files should be referenced with @path. */
const MAX_DOC_BYTES = 256 * 1024;

const TEXT_EXT =
  /\.(txt|md|markdown|log|json|jsonl|ya?ml|toml|xml|html?|css|scss|csv|tsv|ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|m|mm|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|fish|sql|env|ini|cfg|conf|gradle|properties|dockerfile|makefile|patch|diff|graphql|proto|vue|svelte)$/i;

/** True when a picked document is plain text we can read and embed. */
function isTextual(mime: string, name: string): boolean {
  if (mime.startsWith("text/")) return true;
  if (/^application\/(json|xml|.*\+xml|x-yaml|yaml|javascript|x-sh|toml|x-ndjson)/.test(mime))
    return true;
  return TEXT_EXT.test(name);
}

/** Markdown fence language for a filename, so embedded code highlights. "" if unknown. */
function langForName(name: string): string {
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  const map: Record<string, string> = {
    ts: "ts",
    tsx: "tsx",
    js: "js",
    jsx: "jsx",
    mjs: "js",
    cjs: "js",
    py: "python",
    rb: "ruby",
    go: "go",
    rs: "rust",
    java: "java",
    kt: "kotlin",
    swift: "swift",
    c: "c",
    h: "c",
    cc: "cpp",
    cpp: "cpp",
    hpp: "cpp",
    cs: "csharp",
    php: "php",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    sql: "sql",
    html: "html",
    htm: "html",
    css: "css",
    scss: "scss",
    json: "json",
    jsonl: "json",
    md: "markdown",
    markdown: "markdown",
    yml: "yaml",
    yaml: "yaml",
    toml: "toml",
    xml: "xml",
    graphql: "graphql",
    proto: "proto",
    vue: "vue",
    svelte: "svelte",
  };
  return map[ext] ?? "";
}

export interface ComposerSubmit {
  text: string;
  images: RunImage[];
}

/** Imperative handle so a parent (e.g. a "Run" button in the transcript) can
 *  drop text into the composer for the user to review before sending. */
export interface ComposerHandle {
  insert: (text: string) => void;
  /** Append `@path` references (dropped/attached sources) to the draft. */
  addMentions: (paths: string[]) => void;
  /** Append a bare "@" and focus — opens the file-mention autocomplete. */
  startMention: () => void;
  /** Attach local image files (dropped on desktop) as thumbnail attachments. */
  attachImages: (files: { path: string; mediaType: string }[]) => void;
}

interface Attachment {
  uri: string;
  data: string; // base64
  mediaType: string;
}

/**
 * Capability-aware message composer. Shows mode / reasoning / image / slash
 * controls only for agents that support them, then hands a structured submit
 * to the parent (which performs the turn).
 */
export function Composer({
  agent,
  caps,
  disabled = false,
  sending = false,
  running = false,
  placeholder = "Message or steer the agent…",
  hostId,
  cwd,
  onSubmit,
  onStop,
  onViewChanges,
  diffStat,
  model,
  mode,
  tasks,
  markers,
  usage,
  readOnly,
  ref,
}: {
  agent: string;
  caps: AgentCapabilities;
  disabled?: boolean;
  sending?: boolean;
  /** A turn is in flight — swaps the send button for a stop button (when the
   *  input is empty) and lets the user type/queue a follow-up meanwhile. */
  running?: boolean;
  placeholder?: string;
  hostId?: string;
  cwd?: string | null;
  onSubmit: (s: ComposerSubmit) => Promise<void> | void;
  /** Interrupt the running turn (from the stop button). */
  onStop?: () => void;
  /** Open the session's diff review — shows a diff shortcut in the control row. */
  onViewChanges?: () => void;
  /** Working-tree +/- totals shown beside the diff shortcut (null/0s hide it). */
  diffStat?: { add: number; del: number } | null;
  /** Combined model·effort control pill (null to hide). */
  model?: { label: string; onPress: () => void } | null;
  /** Permission-mode control pill (null to hide). */
  mode?: { label: string; active: boolean; onPress: () => void } | null;
  /** Marker jump-list pill — bookmark glyph + count (null to hide). */
  /** The turn's checklist as a toggle — desktop puts the same control in its
   *  status bar. Sits before the marker pill: it describes the turn you're
   *  watching, whereas markers are about the history behind it. */
  tasks?: { done: number; total: number; open: boolean; onPress: () => void } | null;
  markers?: { count: number; onPress: () => void } | null;
  /** Thread usage — drives the context-fill ring (hidden unless the agent
   *  reports both a window and a recent request size). */
  usage?: ThreadUsage | null;
  /** Archived thread: render the pill row (markers are still worth reaching)
   *  but no text field. `disabled` used to cover this, which left a dead input
   *  box and a model selector on a thread whose worktree is gone — controls
   *  that look actionable and aren't, taking a third of the screen with them. */
  readOnly?: boolean;
  ref?: Ref<ComposerHandle>;
}) {
  const { theme } = useUnistyles();
  // The rich input is uncontrolled: `draft` mirrors its plain text (drives the
  // slash/mention menus + canSend), `markdownRef` mirrors the markdown we send,
  // and we push text back through the imperative ref (not a `value` prop).
  const [draft, setDraft] = useState("");
  const inputRef = useRef<EnrichedMarkdownTextInputInstance>(null);
  const markdownRef = useRef("");
  // The native rich input requires STRING colors — pick literal hexes for the
  // active scheme (PlatformColor values can't flow into it).
  const hex = hexFor(useColorScheme());
  /** Inline formatting colours for the rich input (base text color/size come
   *  from the `style` prop). */
  const inputMdStyle = useMemo<MarkdownTextInputStyle>(
    () => ({
      strong: { color: hex.fg },
      em: { color: hex.fg },
      link: { color: hex.accent, underline: false },
    }),
    [hex],
  );
  const setInput = (next: string) => {
    markdownRef.current = next;
    setDraft(next);
    inputRef.current?.setValue(next);
  };
  // Append text to the draft (space-joined) and focus — shared by every
  // handle method that adds to, rather than replaces, what the user typed.
  const appendToDraft = (text: string) => {
    const cur = markdownRef.current.replace(/\s+$/, "");
    setInput(cur ? `${cur} ${text}` : text);
    inputRef.current?.focus();
  };

  useImperativeHandle(ref, () => ({
    insert: (t: string) => {
      setInput(t);
      inputRef.current?.focus();
    },
    addMentions: (paths: string[]) => appendToDraft(`${paths.map((p) => `@${p}`).join(" ")} `),
    startMention: () => appendToDraft("@"),
    attachImages: (files) => {
      for (const f of files) void attachLocalImage(f.path, f.mediaType);
    },
  }));

  // Read a dropped image off local disk (desktop drag-and-drop) and attach it
  // like a picked photo — thumbnail preview + sent as image data.
  const attachLocalImage = async (path: string, mediaType: string) => {
    try {
      const uri = `file://${encodeURI(path)}`;
      const blob = await (await fetch(uri)).blob();
      const data = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        // result = "data:<mime>;base64,<data>" — keep only the payload.
        r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
        r.onerror = () => reject(r.error);
        r.readAsDataURL(blob);
      });
      if (!data) throw new Error("empty file");
      setImages((cur) =>
        cur.some((i) => i.uri === uri) ? cur : [...cur, { uri, data, mediaType }],
      );
    } catch {
      Alert.alert("Couldn't attach image", `${path.split("/").pop()} couldn't be read.`);
    }
  };
  const [images, setImages] = useState<Attachment[]>([]);

  // Voice dictation: fills the input as you speak, with a visible listening state
  // the user controls (tap to start, tap to stop). Base text is preserved so
  // dictation appends to whatever is already typed.
  const [listening, setListening] = useState(false);
  // Hide the mic entirely where dictation can't run (desktop: no
  // expo-speech-recognition macOS/Windows build) instead of showing a button
  // that only ever errors. Assume available until the async probe says otherwise
  // so mobile's mic never flickers in.
  const [voiceAvailable, setVoiceAvailable] = useState(true);
  useEffect(() => {
    let alive = true;
    isVoiceAvailable()
      .then((ok) => alive && setVoiceAvailable(ok))
      .catch(() => alive && setVoiceAvailable(false));
    return () => {
      alive = false;
    };
  }, []);
  const dictationRef = useRef<Dictation | null>(null);
  const voiceBaseRef = useRef("");
  const toggleVoice = async () => {
    if (listening || dictationRef.current) {
      dictationRef.current?.stop();
      return;
    }
    setListening(true);
    voiceBaseRef.current = markdownRef.current.trim();
    const withBase = (t: string) => (voiceBaseRef.current ? `${voiceBaseRef.current} ${t}` : t);
    dictationRef.current = await startDictation({
      onPartial: (t) => setInput(withBase(t)),
      onFinal: (t) => {
        dictationRef.current = null;
        setListening(false);
        if (t) setInput(withBase(t));
        inputRef.current?.focus();
      },
      onError: (kind) => {
        dictationRef.current = null;
        setListening(false);
        if (kind === "permission") {
          Alert.alert(
            "Microphone access needed",
            "Enable Microphone and Speech Recognition for Pounce in Settings to dictate.",
          );
        } else if (kind === "unavailable") {
          Alert.alert(
            "Voice unavailable",
            "Rebuild the dev client (expo run:ios) to enable dictation.",
          );
        } else {
          Alert.alert("Voice error", "Couldn't hear that — try again.");
        }
      },
    });
  };
  // Stop the mic if the composer unmounts mid-dictation.
  useEffect(() => () => dictationRef.current?.stop(), []);

  // Inline slash menu — triggered by a leading "/" while typing the command
  // token (before the first space), like a coding harness.
  const slashQuery =
    !disabled && draft.startsWith("/") && !/\s/.test(draft) ? draft.toLowerCase() : null;
  const slashMatches = slashQuery
    ? SLASH_COMMANDS.filter((c) => c.cmd.toLowerCase().startsWith(slashQuery))
    : [];
  const applySlash = (cmd: string) => setInput(`${cmd} `);

  // Inline @-mention — file/folder autocomplete from the host's cwd. Active
  // when an "@token" is being typed at the end of the input (slash takes
  // priority so the two menus never overlap).
  const mentionMatch = !disabled && !slashQuery ? draft.match(MENTION_RE) : null;
  const mentionQuery = mentionMatch ? mentionMatch[2] : null;
  const mentionActive = mentionQuery !== null;
  const [files, setFiles] = useState<RepoEntry[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);

  useEffect(() => {
    if (mentionQuery === null || !hostId || !cwd) {
      setFiles([]);
      setFilesLoading(false);
      return;
    }
    setFilesLoading(true);
    let cancelled = false;
    const t = setTimeout(async () => {
      const r = await fetchFiles(hostId, cwd, mentionQuery);
      if (!cancelled) {
        setFiles(r);
        setFilesLoading(false);
      }
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [mentionQuery, hostId, cwd]);

  const applyMention = (path: string) =>
    setInput(draft.replace(MENTION_RE, (_m, lead: string) => `${lead}@${path} `));

  const pickImage = async () => {
    try {
      const ImagePicker = await import("../services/imagePicker");
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert("Photos permission needed", "Allow photo access to attach images.");
        return;
      }
      const res = await ImagePicker.launchImageLibraryAsync({
        // API differs across versions: enum on older, string array on newer.
        mediaTypes: (ImagePicker as any).MediaTypeOptions?.Images ?? ["images"],
        base64: true,
        quality: 0.7,
      });
      if (res.canceled || !res.assets?.length) return;
      const a = res.assets[0];
      if (!a.base64) return;
      setImages((cur) => [
        ...cur,
        { uri: a.uri, data: a.base64!, mediaType: a.mimeType || "image/jpeg" },
      ]);
    } catch {
      // Native module not in this dev client build yet.
      Alert.alert(
        "Attachments unavailable",
        "Rebuild the dev client (expo run:ios) to enable photo attachments.",
      );
    }
  };

  // Embed a text document's contents into the draft as a fenced block — the
  // daemon accepts only text + images, so this is how docs reach the agent.
  const appendDoc = (name: string, body: string) => {
    const fence = `${name}:\n\`\`\`${langForName(name)}\n${body.replace(/\s+$/, "")}\n\`\`\``;
    const cur = markdownRef.current.replace(/\s+$/, "");
    setInput(cur ? `${cur}\n\n${fence}\n` : `${fence}\n`);
    inputRef.current?.focus();
  };

  const pickDocument = async () => {
    try {
      const DocumentPicker = await import("../services/documentPicker");
      const res = await DocumentPicker.getDocumentAsync({
        type: "*/*",
        copyToCacheDirectory: true,
      });
      if (res.canceled || !res.assets?.length) return;
      const a = res.assets[0];
      const mime = a.mimeType ?? "";
      const { File } = await import("expo-file-system");
      const file = new File(a.uri);
      if (mime.startsWith("image/")) {
        if (!caps.images) {
          Alert.alert("Images not supported", "This agent can't accept image attachments.");
          return;
        }
        const data = await file.base64();
        setImages((cur) => [...cur, { uri: a.uri, data, mediaType: mime }]);
        return;
      }
      if (isTextual(mime, a.name)) {
        if ((a.size ?? 0) > MAX_DOC_BYTES) {
          Alert.alert(
            "File too large",
            `${a.name} is over 256 KB — reference it with @path or paste the relevant part.`,
          );
          return;
        }
        appendDoc(a.name, await file.text());
        return;
      }
      Alert.alert(
        "Unsupported file",
        `Can't attach ${a.name}. Only images and text files are supported.`,
      );
    } catch {
      Alert.alert(
        "Attachments unavailable",
        "Rebuild the dev client (expo run:ios) to enable file attachments.",
      );
    }
  };

  // "+" offers the camera roll (image models only) and the Files app. With a
  // single option it opens straight through — no needless menu.
  const openAttach = () => {
    const opts: { label: string; run: () => void }[] = [];
    if (caps.images) opts.push({ label: "Photo Library", run: pickImage });
    opts.push({ label: "Files", run: pickDocument });
    if (opts.length === 1) {
      opts[0].run();
      return;
    }
    ActionSheetIOS.showActionSheetWithOptions(
      { options: [...opts.map((o) => o.label), "Cancel"], cancelButtonIndex: opts.length },
      (i) => {
        if (i >= 0 && i < opts.length) opts[i].run();
      },
    );
  };

  // Sending stays allowed while a turn runs — the parent queues follow-ups.
  const hasContent = draft.trim().length > 0 || images.length > 0;
  const canSend = !disabled && hasContent;
  // Empty input during a turn → the primary button interrupts instead of sends.
  const showStop = running && !hasContent && !!onStop;

  const submit = async () => {
    if (!canSend) return;
    // Send the markdown the user composed, not the flattened plain text.
    const snapMarkdown = markdownRef.current;
    const snapImages = images;
    setInput("");
    setImages([]);
    // Sending collapses the keyboard so the streaming reply is visible
    // (Claude/ChatGPT behavior). Keyboard.dismiss() alone is a no-op here: it
    // only blurs inputs registered with RN's TextInputState, which the native
    // markdown editor isn't — blur the instance directly.
    inputRef.current?.blur();
    Keyboard.dismiss();
    try {
      await onSubmit({
        text: snapMarkdown.trim(),
        images: snapImages.map((i) => ({ data: i.data, mediaType: i.mediaType })),
      });
    } catch (err) {
      // restore on failure so the user doesn't lose their message — and say so,
      // or an off-LAN delivery failure looks like the app silently un-sending.
      setInput(snapMarkdown);
      setImages(snapImages);
      const detail = err instanceof Error ? err.message : "";
      Alert.alert(
        "Message not sent",
        detail || "Couldn't reach the host — your message was put back in the box.",
      );
    }
  };

  return (
    <View>
      {/* Image thumbnails */}
      {images.length ? (
        <View style={s.thumbRow}>
          {images.map((img, idx) => (
            <View key={img.uri} style={s.thumbWrap}>
              <Image source={{ uri: img.uri }} style={s.thumb} />
              <Pressable
                onPress={() => setImages((cur) => cur.filter((_, i) => i !== idx))}
                style={s.thumbClose}
              >
                <PounceIcon name="close-circle" size={20} color={theme.colors.fgMuted} />
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}

      {/* Inline slash-command autocomplete (appears as you type "/") */}
      {slashMatches.length ? (
        <View style={s.menuCard}>
          {slashMatches.map((c, i) => (
            <Pressable
              key={c.cmd}
              onPress={() => applySlash(c.cmd)}
              style={({ pressed }) => [
                s.menuRow,
                i > 0 && s.menuRowDivider,
                pressed && s.pressedSurface,
              ]}
            >
              <Text style={s.slashCmd}>{c.cmd}</Text>
              <Text numberOfLines={1} style={s.slashDesc}>
                {c.desc}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {/* Inline @-mention autocomplete (files/folders, appears as you type "@") */}
      {mentionActive ? (
        <View style={[s.menuCard, s.mentionCard]}>
          {!hostId || !cwd ? (
            <Text style={s.menuHint}>Connect a live device to browse this project's files.</Text>
          ) : filesLoading && !files.length ? (
            <Text style={s.menuHint}>Searching files…</Text>
          ) : !files.length ? (
            <Text style={s.menuHint}>No matching files</Text>
          ) : (
            files.map((f, i) => {
              const base = f.path.replace(/\/$/, "").split("/").pop();
              const dir = f.path.slice(0, f.path.length - (base?.length ?? 0));
              return (
                <Pressable
                  key={`${f.type}:${f.path}`}
                  onPress={() => applyMention(f.path)}
                  style={({ pressed }) => [
                    s.menuRow,
                    i > 0 && s.menuRowDivider,
                    pressed && s.pressedSurface,
                  ]}
                >
                  <PounceIcon
                    name={f.type === "dir" ? "folder-outline" : "document-text-outline"}
                    size={15}
                    color={f.type === "dir" ? theme.colors.accent : theme.colors.fgMuted}
                  />
                  <Text numberOfLines={1} style={s.mentionPath}>
                    {dir ? <Text style={s.mentionFaint}>{dir}</Text> : null}
                    {base}
                    {f.type === "dir" ? <Text style={s.mentionFaint}>/</Text> : null}
                  </Text>
                </Pressable>
              );
            })
          )}
        </View>
      ) : null}

      {/* Live "listening" affordance while dictating. */}
      {listening ? <ListeningBanner /> : null}

      {/* Two clusters above the glass pill. Left is what the agent IS — its
          model and mode. Right is what this turn HOLDS — its checklist and the
          markers through its history. They read as two groups because they
          answer two questions; spreading all four edge to edge made the middle
          one look unrelated to either neighbour. */}
      {model || mode || tasks || markers ? (
        <View style={s.pillRow}>
          {model ? <ControlPill agent={agent} label={model.label} onPress={model.onPress} /> : null}
          {mode ? (
            <ControlPill
              icon="git-branch-outline"
              label={mode.label}
              active={mode.active}
              onPress={mode.onPress}
            />
          ) : null}
          <View style={s.flex1} />
          {tasks ? (
            <ControlPill
              icon={tasks.done === tasks.total ? "checkmark-circle" : "ellipse-outline"}
              label={`${tasks.done}/${tasks.total}`}
              active={tasks.open}
              onPress={tasks.onPress}
            />
          ) : null}
          {markers ? (
            <ControlPill
              icon="bookmark"
              label={markers.count > 99 ? "99+" : String(markers.count)}
              onPress={markers.onPress}
            />
          ) : null}
        </View>
      ) : null}

      {/* Floating liquid-glass pill: the text sits above one row of controls —
          attach … mic · send — like iOS 26 Messages. */}
      {!readOnly ? (
        <GlassCard radius={24} shadow style={s.card}>
          <EnrichedMarkdownTextInput
            ref={inputRef}
            onChangeText={setDraft}
            onChangeMarkdown={(md) => {
              markdownRef.current = md;
            }}
            editable={!disabled}
            placeholder={
              disabled ? "Read-only" : running ? "Queue a follow-up or steer…" : placeholder
            }
            placeholderTextColor="#62626D"
            multiline
            markdownStyle={inputMdStyle}
            style={{
              minHeight: 38,
              maxHeight: 120,
              backgroundColor: "transparent",
              paddingHorizontal: 6,
              paddingTop: 6,
              paddingBottom: 4,
              fontSize: 15,
              color: hex.fg,
              opacity: disabled ? 0.5 : 1,
            }}
          />

          <View style={s.controlRow}>
            {!disabled ? <RoundButton icon="add" onPress={openAttach} /> : null}
            {onViewChanges ? (
              <Pressable
                onPress={onViewChanges}
                style={({ pressed }) => [s.diffBtn, pressed && s.pressed70]}
              >
                <PounceIcon name="git-compare-outline" size={19} color={theme.colors.fgMuted} />
                {diffStat && (diffStat.add > 0 || diffStat.del > 0) ? (
                  <Text style={s.diffStatText}>
                    <Text style={s.diffAdd}>+{diffStat.add}</Text>{" "}
                    <Text style={s.diffDel}>-{diffStat.del}</Text>
                  </Text>
                ) : null}
              </Pressable>
            ) : null}

            <View style={s.flex1} />

            <ContextRing usage={usage ?? null} />
            {!disabled && voiceAvailable ? (
              <MicButton listening={listening} onPress={toggleVoice} />
            ) : null}
            {showStop ? (
              <Pressable
                onPress={onStop}
                style={({ pressed }) => [s.stopBtn, pressed && s.pressed80]}
              >
                <PounceIcon name="stop" size={15} color="#fff" />
              </Pressable>
            ) : (
              <Pressable
                onPress={submit}
                disabled={!canSend}
                style={({ pressed }) => [
                  s.sendBtn,
                  !canSend && s.opacity40,
                  pressed && s.pressed80,
                ]}
              >
                <PounceIcon name="arrow-up" size={18} color="#fff" />
              </Pressable>
            )}
          </View>
        </GlassCard>
      ) : null}
    </View>
  );
}

/** A circular icon button (e.g. attach) sized for the composer control row. */
function RoundButton({ icon, onPress }: { icon: IoniconName; onPress: () => void }) {
  const { theme } = useUnistyles();
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [s.roundBtn, pressed && s.pressed70]}>
      <PounceIcon name={icon} size={19} color={theme.colors.fgMuted} />
    </Pressable>
  );
}

/** A pill control in the composer row — model·effort, or the permission mode.
 *  Shows the agent logo (model) or an icon (mode) + a trailing chevron. */
function ControlPill({
  agent,
  icon,
  label,
  active,
  onPress,
}: {
  agent?: string;
  icon?: IoniconName;
  label: string;
  active?: boolean;
  onPress: () => void;
}) {
  const { theme } = useUnistyles();
  return (
    <Pressable
      onPress={onPress}
      hitSlop={4}
      // pill flexShrink/minWidth: yoga's flexShrink defaults to 0, so a long
      // label ("Accept edits", a long model name) would push the mic/send
      // buttons off-screen instead of truncating.
      style={({ pressed }) => [s.pill, active ? s.pillActive : s.pillIdle, pressed && s.pressed70]}
    >
      {agent ? <AgentLogo agent={agent} size={13} /> : null}
      {icon ? (
        <PounceIcon
          name={icon}
          size={12}
          color={active ? theme.colors.accent : theme.colors.fgMuted}
        />
      ) : null}
      <Text numberOfLines={1} style={[s.pillLabel, active ? s.pillLabelActive : s.pillLabelIdle]}>
        {label}
      </Text>
      <PounceIcon
        name="chevron-down"
        size={11}
        color={active ? theme.colors.accent : theme.colors.fgFaint}
      />
    </Pressable>
  );
}

/** Mic toggle for dictation. Idle: an outline mic. Listening: a pulsing red dot
 *  with a filled mic — unmistakable that the mic is live and how to stop it. */
function MicButton({ listening, onPress }: { listening: boolean; onPress: () => void }) {
  const { theme } = useUnistyles();
  const sc = useSharedValue(1);
  useEffect(() => {
    if (listening) {
      sc.value = withRepeat(
        withSequence(withTiming(1.15, { duration: 500 }), withTiming(0.85, { duration: 500 })),
        -1,
        true,
      );
    } else {
      cancelAnimation(sc);
      sc.value = 1;
    }
  }, [listening, sc]);
  const style = useAnimatedStyle(() => ({ transform: [{ scale: sc.value }] }));
  return (
    <Pressable onPress={onPress} hitSlop={6} style={s.micBtn}>
      {listening ? (
        // Animated.View: keep the static COLOR token — unistyles theme styles
        // must not mix into reanimated-managed styles.
        <Animated.View
          style={[
            style,
            s.micLive,
            { width: 28, height: 28, borderRadius: 14, backgroundColor: COLOR.danger },
          ]}
        >
          <PounceIcon name="mic" size={16} color="#fff" />
        </Animated.View>
      ) : (
        <PounceIcon name="mic-outline" size={22} color={theme.colors.fgMuted} />
      )}
    </Pressable>
  );
}

/** One equalizer bar for the listening banner. */
function Bar({ delay }: { delay: number }) {
  const h = useSharedValue(5);
  useEffect(() => {
    h.value = withDelay(
      delay,
      withRepeat(
        withSequence(withTiming(15, { duration: 340 }), withTiming(5, { duration: 340 })),
        -1,
        true,
      ),
    );
  }, [h, delay]);
  const style = useAnimatedStyle(() => ({ height: h.value }));
  // Animated.View: keep the static COLOR token — unistyles theme styles must not
  // mix into reanimated-managed styles.
  return (
    <Animated.View style={[style, { width: 3, borderRadius: 2, backgroundColor: COLOR.danger }]} />
  );
}

/** "Listening…" pill with an animated equalizer — shown while dictating. */
function ListeningBanner() {
  return (
    <View style={s.listenBanner}>
      <View style={[s.listenBars, { height: 15 }]}>
        <Bar delay={0} />
        <Bar delay={110} />
        <Bar delay={220} />
        <Bar delay={110} />
      </View>
      <Text style={s.listenLabel}>Listening… tap the mic to stop</Text>
    </View>
  );
}

const s = StyleSheet.create((theme) => ({
  flex1: { flex: 1 },
  thumbRow: {
    marginHorizontal: 12,
    marginBottom: 8,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  thumbWrap: { position: "relative" },
  thumb: { height: 56, width: 56, borderRadius: 8 },
  thumbClose: {
    position: "absolute",
    right: -6,
    top: -6,
    height: 20,
    width: 20,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 999,
    backgroundColor: theme.colors.bg,
  },
  menuCard: {
    marginHorizontal: 12,
    marginBottom: 8,
    overflow: "hidden",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  mentionCard: { maxHeight: 240 },
  menuRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  menuRowDivider: { borderTopWidth: 1, borderColor: theme.colors.border },
  pressedSurface: { backgroundColor: theme.colors.surfaceHover },
  menuHint: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 12,
    color: theme.colors.fgFaint,
  },
  slashCmd: { fontFamily: "JetBrainsMono", fontSize: 13, color: theme.colors.accent },
  slashDesc: { flex: 1, fontSize: 12, color: theme.colors.fgMuted },
  mentionPath: { flex: 1, fontFamily: "JetBrainsMono", fontSize: 12, color: theme.colors.fg },
  mentionFaint: { color: theme.colors.fgFaint },
  card: {
    marginHorizontal: 12,
    marginBottom: 8,
    paddingHorizontal: 10,
    paddingBottom: 8,
    paddingTop: 6,
  },
  pillRow: {
    marginHorizontal: 12,
    marginBottom: 8,
    flexDirection: "row",
    alignItems: "center",
    // A flexible spacer splits the row instead of space-between, which would
    // push every pill to its own third of the width.
    gap: 6,
  },
  controlRow: { marginTop: 4, flexDirection: "row", alignItems: "center", gap: 6 },
  diffBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    height: 36,
    paddingHorizontal: 4,
  },
  diffStatText: { fontSize: 12, fontWeight: "600" },
  diffAdd: { color: theme.colors.success },
  diffDel: { color: theme.colors.danger },
  roundBtn: {
    height: 32,
    width: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 999,
    backgroundColor: "transparent",
  },
  pill: {
    height: 28,
    minWidth: 0,
    flexShrink: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 999,
    paddingHorizontal: 10,
  },
  pillIdle: { backgroundColor: theme.colors.surfaceAlt },
  pillActive: { backgroundColor: theme.colors.accentSoft },
  pillLabel: { maxWidth: 150, flexShrink: 1, fontSize: 13, fontWeight: "500" },
  pillLabelIdle: { color: theme.colors.fg },
  pillLabelActive: { color: theme.colors.accent },
  stopBtn: {
    height: 36,
    width: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 999,
    backgroundColor: theme.colors.danger,
  },
  sendBtn: {
    height: 36,
    width: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 999,
    backgroundColor: theme.colors.accent,
  },
  opacity40: { opacity: 0.4 },
  pressed70: { opacity: 0.7 },
  pressed80: { opacity: 0.8 },
  micBtn: { height: 40, width: 36, alignItems: "center", justifyContent: "center" },
  micLive: { alignItems: "center", justifyContent: "center" },
  listenBanner: {
    marginHorizontal: 12,
    marginBottom: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    alignSelf: "flex-start",
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(248, 81, 73, 0.4)",
    backgroundColor: "rgba(248, 81, 73, 0.1)",
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  listenBars: { flexDirection: "row", alignItems: "flex-end", gap: 2 },
  listenLabel: { fontSize: 12, fontWeight: "500", color: theme.colors.danger },
}));
