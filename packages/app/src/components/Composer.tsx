import { useEffect, useState } from "react";
import { ActionSheetIOS, Alert, Image, Pressable, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { AgentCapabilities, PermissionMode, RunImage } from "@litter/shared";
import {
  modesFor,
  REASONING_EFFORTS,
  SLASH_COMMANDS,
  type ReasoningEffort,
} from "../ui/agent-meta";
import { fetchFiles, type RepoEntry } from "../services/bridge";
import { cn, COLOR, INPUT_TWEAKS } from "../ui";

const MENTION_RE = /((?:^|\s))@([^\s@]*)$/;

export interface ComposerSubmit {
  text: string;
  images: RunImage[];
  permissionMode?: PermissionMode;
  reasoningEffort?: ReasoningEffort;
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
}: {
  agent: string;
  caps: AgentCapabilities;
  disabled?: boolean;
  sending?: boolean;
  placeholder?: string;
  hostId?: string;
  cwd?: string | null;
  onSubmit: (s: ComposerSubmit) => Promise<void> | void;
}) {
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<Attachment[]>([]);
  const [optionsOpen, setOptionsOpen] = useState(false);

  const modes = modesFor(agent);
  const showMode = modes.length > 1;
  const showEffort = caps.thinking;
  const showAttach = caps.images;
  const hasOptions = showMode || showEffort || showAttach;

  const [mode, setMode] = useState<PermissionMode | undefined>(modes[0]?.value);
  const [effort, setEffort] = useState<ReasoningEffort | undefined>(undefined);

  const modeLabel = modes.find((m) => m.value === mode)?.label ?? "Mode";
  const effortLabel = REASONING_EFFORTS.find((e) => e.value === effort)?.label;

  const sheet = (title: string, labels: string[], onPick: (i: number) => void) =>
    ActionSheetIOS.showActionSheetWithOptions(
      { title, options: [...labels, "Cancel"], cancelButtonIndex: labels.length },
      (i) => {
        if (i >= 0 && i < labels.length) onPick(i);
      },
    );

  const openMode = () =>
    sheet("Mode", modes.map((m) => `${m.label} · ${m.hint}`), (i) => setMode(modes[i].value));

  const openEffort = () =>
    sheet("Reasoning effort", REASONING_EFFORTS.map((e) => e.label), (i) =>
      setEffort(REASONING_EFFORTS[i].value),
    );

  // Inline slash menu — triggered by a leading "/" while typing the command
  // token (before the first space), like a coding harness.
  const slashQuery =
    !disabled && draft.startsWith("/") && !/\s/.test(draft) ? draft.toLowerCase() : null;
  const slashMatches = slashQuery
    ? SLASH_COMMANDS.filter((c) => c.cmd.toLowerCase().startsWith(slashQuery))
    : [];
  const applySlash = (cmd: string) => setDraft(`${cmd} `);

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
    setDraft((d) => d.replace(MENTION_RE, (_m, lead: string) => `${lead}@${path} `));

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
      setImages((cur) => [...cur, { uri: a.uri, data: a.base64!, mediaType: a.mimeType || "image/jpeg" }]);
    } catch {
      // Native module not in this dev client build yet.
      Alert.alert("Attachments unavailable", "Rebuild the dev client (expo run:ios) to enable photo attachments.");
    }
  };

  const canSend = !disabled && !sending && (draft.trim().length > 0 || images.length > 0);

  const submit = async () => {
    if (!canSend) return;
    const snapText = draft;
    const snapImages = images;
    setDraft("");
    setImages([]);
    try {
      await onSubmit({
        text: snapText.trim(),
        images: snapImages.map((i) => ({ data: i.data, mediaType: i.mediaType })),
        permissionMode: showMode ? mode : undefined,
        reasoningEffort: showEffort ? effort : undefined,
      });
    } catch {
      // restore on failure so the user doesn't lose their message
      setDraft(snapText);
      setImages(snapImages);
    }
  };

  return (
    <View>
      {/* Options — revealed by the "+", so the default composer stays minimal */}
      {optionsOpen && !disabled ? (
        <View className="mb-2 flex-row flex-wrap items-center gap-2">
          {showMode ? (
            <Pill icon="git-branch-outline" label={modeLabel} active={mode !== "default"} onPress={openMode} />
          ) : null}
          {showEffort ? (
            <Pill
              icon="flash-outline"
              label={effortLabel ? `Effort · ${effortLabel}` : "Effort"}
              active={!!effort && effort !== "off"}
              onPress={openEffort}
            />
          ) : null}
          {showAttach ? (
            <Pill icon="image-outline" label="Image" active={images.length > 0} onPress={pickImage} />
          ) : null}
        </View>
      ) : null}

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
        {!disabled && hasOptions ? (
          <IconButton icon={optionsOpen ? "close" : "add"} onPress={() => setOptionsOpen((o) => !o)} />
        ) : null}

        <TextInput {...INPUT_TWEAKS}
          value={draft}
          onChangeText={setDraft}
          editable={!disabled && !sending}
          placeholder={disabled ? "Read-only" : placeholder}
          placeholderTextColor="#62626D"
          multiline
          className={cn(
            "max-h-[120px] min-h-[40px] flex-1 rounded-2xl bg-surface-alt px-3 pt-2 text-[15px] text-fg",
            disabled && "opacity-50",
          )}
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

function Pill({
  icon,
  label,
  active,
  onPress,
}: {
  icon: React.ComponentProps<typeof Ionicons>["name"];
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      className={cn(
        "h-8 flex-row items-center gap-1.5 rounded-full border px-3",
        active ? "border-accent/60 bg-accent-soft" : "border-border bg-surface-alt active:bg-surface-hover",
      )}
    >
      <Ionicons name={icon} size={13} color={active ? COLOR.accent : COLOR.fgMuted} />
      <Text className={cn("text-[12px] font-medium", active ? "text-accent" : "text-fg-muted")}>{label}</Text>
      <Ionicons name="chevron-down" size={12} color={active ? COLOR.accent : COLOR.fgFaint} />
    </Pressable>
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
