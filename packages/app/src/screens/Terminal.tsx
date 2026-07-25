import { useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Platform } from "react-native";
import { KeyboardAvoidingView } from "../components/kav";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { PounceIcon } from "../ui/native/Icon";
import { runExec } from "../services/bridge";
import { useThread } from "../state/db/hooks";

interface Entry {
  command: string;
  output: string;
  code: number;
}

/** A one-shot command runner against a session's host + cwd. */
export default function TerminalScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { theme } = useUnistyles();
  const session = useThread(id);

  const [command, setCommand] = useState("");
  const [history, setHistory] = useState<Entry[]>([]);
  const [running, setRunning] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  const run = async () => {
    const cmd = command.trim();
    if (!cmd || running || !session) return;
    setRunning(true);
    setCommand("");
    try {
      const { code, output } = await runExec(session.hostId, session.cwd, cmd);
      setHistory((h) => [...h, { command: cmd, output, code }]);
      requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));
    } finally {
      setRunning(false);
    }
  };

  const cwdShort = session?.cwd ? session.cwd.replace(/^.*\//, "") : "~";

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={[s.root, { paddingTop: insets.top + 6 }]}
    >
      <View style={s.header}>
        <Pressable
          onPress={() => router.back()}
          style={({ pressed }) => [s.iconBtn, pressed && s.pressed60]}
        >
          <PounceIcon name="chevron-down" size={22} color={theme.colors.fg} />
        </Pressable>
        <View style={s.flex1}>
          <Text style={s.title}>Terminal</Text>
          <Text numberOfLines={1} style={s.subtitle}>
            {session?.host} · {cwdShort}
          </Text>
        </View>
      </View>

      <ScrollView ref={scrollRef} style={s.scroll} contentContainerStyle={{ padding: 12, gap: 12 }}>
        {history.length === 0 ? (
          <Text style={s.emptyHint}>
            Run a command on {session?.host ?? "the host"} — e.g. `git status`, `npm test`, `ls`.
          </Text>
        ) : null}
        {history.map((e, i) => (
          <View key={i}>
            <View style={s.cmdRow}>
              <Text style={s.promptGlyph}>❯</Text>
              <Text style={s.cmdText}>{e.command}</Text>
              {e.code !== 0 ? <Text style={s.exitCode}>exit {e.code}</Text> : null}
            </View>
            {e.output ? <Text style={s.output}>{e.output}</Text> : null}
          </View>
        ))}
        {running ? (
          <View style={s.runningRow}>
            <ActivityIndicator color={theme.colors.fgMuted} size="small" />
            <Text style={s.runningText}>running…</Text>
          </View>
        ) : null}
      </ScrollView>

      <View style={[s.footer, { paddingBottom: insets.bottom + 8 }]}>
        <View style={s.inputRow}>
          <Text style={s.inputPrompt}>❯</Text>
          <TextInput
            value={command}
            onChangeText={setCommand}
            editable={!running}
            placeholder="command…"
            placeholderTextColor={theme.colors.fgFaint}
            autoCapitalize="none"
            autoCorrect={false}
            onSubmitEditing={run}
            returnKeyType="go"
            style={s.input}
          />
          <Pressable
            onPress={run}
            disabled={!command.trim() || running}
            style={[s.sendBtn, (!command.trim() || running) && s.opacity40]}
          >
            <PounceIcon name="arrow-up" size={20} color={theme.colors.onAccent} />
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create((theme) => ({
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
  flex1: { flex: 1 },
  title: { fontSize: 17, fontWeight: "600", color: theme.colors.fg },
  subtitle: { fontFamily: "JetBrainsMono", fontSize: 11, color: theme.colors.fgFaint },
  scroll: { flex: 1, borderTopWidth: 1, borderColor: theme.colors.border },
  emptyHint: { marginTop: 32, textAlign: "center", fontSize: 13, color: theme.colors.fgFaint },
  cmdRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  promptGlyph: { fontFamily: "JetBrainsMono", fontSize: 12, color: theme.colors.accent },
  cmdText: { flex: 1, fontFamily: "JetBrainsMono", fontSize: 12, color: theme.colors.fg },
  exitCode: { fontFamily: "JetBrainsMono", fontSize: 11, color: theme.colors.danger },
  output: {
    marginTop: 4,
    fontFamily: "JetBrainsMono",
    fontSize: 11,
    lineHeight: 16,
    color: theme.colors.fgMuted,
  },
  runningRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  runningText: { fontFamily: "JetBrainsMono", fontSize: 12, color: theme.colors.fgFaint },
  // Transparent, borderless bar to match the floating-composer look elsewhere.
  footer: {
    paddingHorizontal: 12,
    paddingTop: 8,
  },
  inputRow: { flexDirection: "row", alignItems: "flex-end", gap: 8 },
  inputPrompt: {
    paddingBottom: 8,
    fontFamily: "JetBrainsMono",
    fontSize: 14,
    color: theme.colors.accent,
  },
  input: {
    maxHeight: 90,
    minHeight: 40,
    flex: 1,
    borderRadius: 16,
    backgroundColor: theme.colors.surfaceAlt,
    paddingHorizontal: 12,
    paddingTop: 8,
    fontFamily: "JetBrainsMono",
    fontSize: 14,
    color: theme.colors.fg,
  },
  sendBtn: {
    height: 40,
    width: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 999,
    backgroundColor: theme.colors.accent,
  },
  opacity40: { opacity: 0.4 },
}));
