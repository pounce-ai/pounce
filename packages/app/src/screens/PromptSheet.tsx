/**
 * The prompt form sheet — a native formSheet route (expo-router presentation,
 * not an RN Modal) that auto-presents over the Session screen whenever its
 * thread blocks on an interactive prompt. Renders the same shared PromptForm as
 * the inline timeline card; answering (or the prompt resolving anywhere else —
 * the terminal, another device) dismisses it.
 */
import { useEffect, useRef } from "react";
import { Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSelector } from "@legendapp/state/react";
import { Ionicons } from "@expo/vector-icons";
import { PromptForm } from "../components/PromptForm";
import { respondPrompt, sendSessionInput } from "../services/bridge";
import { clearPendingPrompt, pendingPrompts$ } from "../state/stores";
import { useThread } from "../state/db/hooks";
import { COLOR } from "../ui";

export default function PromptSheetScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
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
    <View className="bg-bg-elevated px-5 pb-10 pt-4">
      <View className="mb-4 items-center">
        <View className="mb-3 h-1 w-9 rounded-full bg-border" />
        {session ? (
          <Text numberOfLines={1} className="text-[12px] text-fg-muted">
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
        <View className="flex-row items-center justify-center gap-2 py-6">
          <Ionicons name="checkmark-circle-outline" size={18} color={COLOR.fgMuted} />
          <Text className="text-[13px] text-fg-muted">This prompt was already answered.</Text>
        </View>
      )}
    </View>
  );
}
