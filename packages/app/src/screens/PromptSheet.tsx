/**
 * The prompt form sheet — a native formSheet route (expo-router presentation,
 * not an RN Modal) that auto-presents over the Session screen whenever its
 * thread blocks on an interactive prompt. Renders the same shared PromptForm as
 * the inline timeline card; answering (or the prompt resolving anywhere else —
 * the terminal, another device) dismisses it.
 */
import { useEffect, useRef } from "react";
import { Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSelector } from "@legendapp/state/react";
import { PounceIcon } from "../ui/native/Icon";
import { PromptForm } from "../components/PromptForm";
import { respondPrompt, sendSessionInput } from "../services/bridge";
import { clearPendingPrompt, pendingPrompts$ } from "../state/stores";
import { useThread } from "../state/db/hooks";

export default function PromptSheetScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { theme } = useUnistyles();
  const session = useThread(id);
  const pending = useSelector(() => pendingPrompts$[id!].get());
  const answered = useRef(false);

  // The prompt resolved somewhere else (terminal keystroke, another device,
  // turn cancelled) while the sheet was up: show "Resolved" for a beat, then
  // dismiss. Skipped when WE answered — that path already navigated back.
  const open = !!pending;
  useEffect(() => {
    if (open || answered.current) return;
    const t = setTimeout(() => {
      if (router.canGoBack()) router.back();
    }, 1200);
    return () => clearTimeout(t);
  }, [open, router]);

  const done = () => {
    answered.current = true;
    if (id) clearPendingPrompt(id);
    if (router.canGoBack()) router.back();
  };

  return (
    <View style={s.root}>
      <View style={s.header}>
        <View style={s.grabber} />
        {session ? (
          <Text numberOfLines={1} style={s.title}>
            {session.title}
          </Text>
        ) : null}
      </View>
      {pending ? (
        <PromptForm
          prompt={pending}
          onRespond={(_promptId, optionIndex) => {
            void respondPrompt(pending.hostId, pending.threadId, optionIndex);
          }}
          onSendInput={(data) => {
            void sendSessionInput(pending.hostId, pending.threadId, data);
          }}
          onAnswered={done}
        />
      ) : (
        <View style={s.resolvedRow}>
          <PounceIcon name="checkmark-circle-outline" size={18} color={theme.colors.fgMuted} />
          <Text style={s.resolvedText}>This prompt was already answered.</Text>
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create((theme) => ({
  root: {
    backgroundColor: theme.colors.bgElevated,
    paddingHorizontal: 20,
    paddingBottom: 40,
    paddingTop: 16,
  },
  header: { marginBottom: 16, alignItems: "center" },
  grabber: {
    marginBottom: 12,
    height: 4,
    width: 36,
    borderRadius: 999,
    backgroundColor: theme.colors.border,
  },
  title: { fontSize: 12, color: theme.colors.fgMuted },
  resolvedRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 24,
  },
  resolvedText: { fontSize: 13, color: theme.colors.fgMuted },
}));
