import { type Ref, useEffect, useImperativeHandle, useRef, useState } from "react";
import { ActionSheetIOS, Alert, Image, Pressable, Text, View } from "react-native";
import {
  EnrichedMarkdownTextInput,
  type EnrichedMarkdownTextInputInstance,
  type MarkdownTextInputStyle,
} from "react-native-enriched-markdown";
import { Ionicons } from "@expo/vector-icons";
import type { AgentCapabilities, RunImage } from "@litter/shared";
import { SLASH_COMMANDS } from "@/ui/agent-meta";
import { fetchFiles, type RepoEntry } from "@/services/bridge";
import { cn, COLOR } from "@/ui";

const MENTION_RE = /((?:^|\s))@([^\s@]*)$/;

/** The daemon has no document channel, so a text file is embedded inline in the
 *  message. Cap the inline size — bigger files should be referenced with @path. */
const MAX_DOC_BYTES = 256 * 1024;

const TEXT_EXT =
  /\.(txt|md|markdown|log|json|jsonl|ya?ml|toml|xml|html?|css|scss|csv|tsv|ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|m|mm|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|fish|sql|env|ini|cfg|conf|gradle|properties|dockerfile|makefile|patch|diff|graphql|proto|vue|svelte)$/i;

/** True when a picked document is plain text we can read and embed. */
function isTextual(mime: string, name: string): boolean {
  if (mime.startsWith("text/")) return true;
  if (/^application\/(json|xml|.*\+xml|x-yaml|yaml|javascript|x-sh|toml|x-ndjson)/.test(mime)) return true;
  return TEXT_EXT.test(name);
}

/** Markdown fence language for a filename, so embedded code highlights. "" if unknown. */
function langForName(name: string): string {
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  const map: Record<string, string> = {
    ts: "ts", tsx: "tsx", js: "js", jsx: "jsx", mjs: "js", cjs: "js", py: "python",
    rb: "ruby", go: "go", rs: "rust", java: "java", kt: "kotlin", swift: "swift",
    c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp", cs: "csharp", php: "php",
    sh: "bash", bash: "bash", zsh: "bash", sql: "sql", html: "html", htm: "html",
    css: "css", scss: "scss", json: "json", jsonl: "json", md: "markdown",
    markdown: "markdown", yml: "yaml", yaml: "yaml", toml: "toml", xml: "xml",
    graphql: "graphql", proto: "proto", vue: "vue", svelte: "svelte",
  };
  return map[ext] ?? "";
}

/** Inline formatting colours for the rich input (base text color/size come from
 *  the `style` prop). */
const INPUT_MD_STYLE: MarkdownTextInputStyle = {
  strong: { color: COLOR.fg },
  em: { color: COLOR.fg },
  link: { color: COLOR.accent, underline: false },
};

export interface ComposerSubmit {
  text: string;
  images: RunImage[];
}

/** Imperative handle so a parent (e.g. a "Run" button in the transcript) can
 *  drop text into the composer for the user to review before sending. */
export interface ComposerHandle {
  insert: (text: string) => void;
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
  placeholder = "Message or steer the agent…",
  hostId,
  cwd,
  onSubmit,
  ref,
}: {
  agent: string;
  caps: AgentCapabilities;
  disabled?: boolean;
  sending?: boolean;
  placeholder?: string;
  hostId?: string;
  cwd?: string | null;
  onSubmit: (s: ComposerSubmit) => Promise<void> | void;
  ref?: Ref<ComposerHandle>;
}) {
  // The rich input is uncontrolled: `draft` mirrors its plain text (drives the
  // slash/mention menus + canSend), `markdownRef` mirrors the markdown we send,
  // and we push text back through the imperative ref (not a `value` prop).
  const [draft, setDraft] = useState("");
  const inputRef = useRef<EnrichedMarkdownTextInputInstance>(null);
  const markdownRef = useRef("");
  const setInput = (next: string) => {
    markdownRef.current = next;
    setDraft(next);
    inputRef.current?.setValue(next);
  };
  useImperativeHandle(ref, () => ({
    insert: (t: string) => {
      setInput(t);
      inputRef.current?.focus();
    },
  }));
  const [images, setImages] = useState<Attachment[]>([]);

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
      const ImagePicker = await import("expo-image-picker");
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
      setImages((cur) => [...cur, { uri: a.uri, data: a.base64!, mediaType: a.mimeType || "image/jpeg" }]);
    } catch {
      // Native module not in this dev client build yet.
      Alert.alert("Attachments unavailable", "Rebuild the dev client (expo run:ios) to enable photo attachments.");
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
      const DocumentPicker = await import("expo-document-picker");
      const res = await DocumentPicker.getDocumentAsync({ type: "*/*", copyToCacheDirectory: true });
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
          Alert.alert("File too large", `${a.name} is over 256 KB — reference it with @path or paste the relevant part.`);
          return;
        }
        appendDoc(a.name, await file.text());
        return;
      }
      Alert.alert("Unsupported file", `Can't attach ${a.name}. Only images and text files are supported.`);
    } catch {
      Alert.alert("Attachments unavailable", "Rebuild the dev client (expo run:ios) to enable file attachments.");
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
      (i) => { if (i >= 0 && i < opts.length) opts[i].run(); },
    );
  };

  const canSend = !disabled && !sending && (draft.trim().length > 0 || images.length > 0);

  const submit = async () => {
    if (!canSend) return;
    // Send the markdown the user composed, not the flattened plain text.
    const snapMarkdown = markdownRef.current;
    const snapImages = images;
    setInput("");
    setImages([]);
    try {
      await onSubmit({
        text: snapMarkdown.trim(),
        images: snapImages.map((i) => ({ data: i.data, mediaType: i.mediaType })),
      });
    } catch {
      // restore on failure so the user doesn't lose their message
      setInput(snapMarkdown);
      setImages(snapImages);
    }
  };

  return (
    <View>
      {/* Image thumbnails */}
      {images.length ? (
        <View className="mb-2 flex-row flex-wrap gap-2">
          {images.map((img, idx) => (
            <View key={img.uri} className="relative">
              <Image source={{ uri: img.uri }} className="h-14 w-14 rounded-lg" />
              <Pressable
                onPress={() => setImages((cur) => cur.filter((_, i) => i !== idx))}
                className="absolute -right-1.5 -top-1.5 h-5 w-5 items-center justify-center rounded-full bg-bg"
              >
                <Ionicons name="close-circle" size={20} color={COLOR.fgMuted} />
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}

      {/* Inline slash-command autocomplete (appears as you type "/") */}
      {slashMatches.length ? (
        <View className="mb-2 overflow-hidden rounded-2xl border border-border bg-surface">
          {slashMatches.map((c, i) => (
            <Pressable
              key={c.cmd}
              onPress={() => applySlash(c.cmd)}
              className={cn(
                "flex-row items-center gap-2 px-3 py-2.5 active:bg-surface-hover",
                i > 0 && "border-t border-border/60",
              )}
            >
              <Text className="font-mono text-[13px] text-accent">{c.cmd}</Text>
              <Text numberOfLines={1} className="flex-1 text-[12px] text-fg-muted">
                {c.desc}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {/* Inline @-mention autocomplete (files/folders, appears as you type "@") */}
      {mentionActive ? (
        <View className="mb-2 max-h-60 overflow-hidden rounded-2xl border border-border bg-surface">
          {!hostId || !cwd ? (
            <Text className="px-3 py-2.5 text-[12px] text-fg-faint">
              Connect a live device to browse this project's files.
            </Text>
          ) : filesLoading && !files.length ? (
            <Text className="px-3 py-2.5 text-[12px] text-fg-faint">Searching files…</Text>
          ) : !files.length ? (
            <Text className="px-3 py-2.5 text-[12px] text-fg-faint">No matching files</Text>
          ) : (
            files.map((f, i) => {
            const base = f.path.replace(/\/$/, "").split("/").pop();
            const dir = f.path.slice(0, f.path.length - (base?.length ?? 0));
            return (
              <Pressable
                key={`${f.type}:${f.path}`}
                onPress={() => applyMention(f.path)}
                className={cn(
                  "flex-row items-center gap-2 px-3 py-2.5 active:bg-surface-hover",
                  i > 0 && "border-t border-border/60",
                )}
              >
                <Ionicons
                  name={f.type === "dir" ? "folder-outline" : "document-text-outline"}
                  size={15}
                  color={f.type === "dir" ? COLOR.accent : COLOR.fgMuted}
                />
                <Text numberOfLines={1} className="flex-1 font-mono text-[12px] text-fg">
                  {dir ? <Text className="text-fg-faint">{dir}</Text> : null}
                  {base}
                  {f.type === "dir" ? <Text className="text-fg-faint">/</Text> : null}
                </Text>
              </Pressable>
            );
            })
          )}
        </View>
      ) : null}

      {/* Input row */}
      <View className="flex-row items-end gap-2">
        {!disabled ? <IconButton icon="add" onPress={openAttach} /> : null}

        <EnrichedMarkdownTextInput
          ref={inputRef}
          onChangeText={setDraft}
          onChangeMarkdown={(md) => {
            markdownRef.current = md;
          }}
          editable={!disabled && !sending}
          placeholder={disabled ? "Read-only" : placeholder}
          placeholderTextColor="#62626D"
          multiline
          markdownStyle={INPUT_MD_STYLE}
          style={{
            flex: 1,
            minHeight: 40,
            maxHeight: 120,
            backgroundColor: "#1b1b22",
            borderRadius: 16,
            paddingHorizontal: 12,
            paddingTop: 8,
            paddingBottom: 8,
            fontSize: 15,
            color: COLOR.fg,
            opacity: disabled ? 0.5 : 1,
          }}
        />

        <Pressable
          onPress={submit}
          disabled={!canSend}
          className={cn(
            "h-10 w-10 items-center justify-center rounded-full bg-accent",
            !canSend && "opacity-40",
          )}
        >
          <Ionicons name="arrow-up" size={20} color="#fff" />
        </Pressable>
      </View>
    </View>
  );
}

function IconButton({
  icon,
  onPress,
}: {
  icon: React.ComponentProps<typeof Ionicons>["name"];
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} className="active:opacity-60 h-10 w-9 items-center justify-center">
      <Ionicons name={icon} size={22} color={COLOR.fgMuted} />
    </Pressable>
  );
}
