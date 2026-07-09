import { useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { KeyboardAvoidingView, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { runExec } from "@/services/bridge";
import { useThread } from "@/state/db/hooks";
import { cn, COLOR } from "@/ui";

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
      className="flex-1 bg-bg"
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={{ paddingTop: insets.top + 6 }}
    >
      <View className="flex-row items-center gap-2 px-3 pb-2">
        <Pressable onPress={() => router.back()} className="active:opacity-60 h-9 w-9 items-center justify-center">
          <Ionicons name="chevron-down" size={22} color={COLOR.fg} />
        </Pressable>
        <View className="flex-1">
          <Text className="text-[17px] font-semibold text-fg">Terminal</Text>
          <Text numberOfLines={1} className="font-mono text-[11px] text-fg-faint">
            {session?.host} · {cwdShort}
          </Text>
        </View>
      </View>

      <ScrollView
        ref={scrollRef}
        className="flex-1 border-t border-border"
        contentContainerStyle={{ padding: 12, gap: 12 }}
      >
        {history.length === 0 ? (
          <Text className="mt-8 text-center text-[13px] text-fg-faint">
            Run a command on {session?.host ?? "the host"} — e.g. `git status`, `npm test`, `ls`.
          </Text>
        ) : null}
        {history.map((e, i) => (
          <View key={i}>
            <View className="flex-row items-center gap-1.5">
              <Text className="font-mono text-[12px] text-accent">❯</Text>
              <Text className="flex-1 font-mono text-[12px] text-fg">{e.command}</Text>
              {e.code !== 0 ? (
                <Text className="font-mono text-[11px] text-danger">exit {e.code}</Text>
              ) : null}
            </View>
            {e.output ? (
              <Text className="mt-1 font-mono text-[11px] leading-[16px] text-fg-muted">{e.output}</Text>
            ) : null}
          </View>
        ))}
        {running ? (
          <View className="flex-row items-center gap-2">
            <ActivityIndicator color={COLOR.fgMuted} size="small" />
            <Text className="font-mono text-[12px] text-fg-faint">running…</Text>
          </View>
        ) : null}
      </ScrollView>

      <View style={{ paddingBottom: insets.bottom + 8 }} className="border-t border-border bg-bg-elevated px-3 pt-2">
        <View className="flex-row items-end gap-2">
          <Text className="pb-2 font-mono text-[14px] text-accent">❯</Text>
          <TextInput
            value={command}
            onChangeText={setCommand}
            editable={!running}
            placeholder="command…"
            placeholderTextColor="#62626D"
            autoCapitalize="none"
            autoCorrect={false}
            onSubmitEditing={run}
            returnKeyType="go"
            className="max-h-[90px] min-h-[40px] flex-1 rounded-2xl bg-surface-alt px-3 pt-2 font-mono text-[14px] text-fg"
          />
          <Pressable
            onPress={run}
            disabled={!command.trim() || running}
            className={cn(
              "h-10 w-10 items-center justify-center rounded-full bg-accent",
              (!command.trim() || running) && "opacity-40",
            )}
          >
            <Ionicons name="arrow-up" size={20} color="#fff" />
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}
