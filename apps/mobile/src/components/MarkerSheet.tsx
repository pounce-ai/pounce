import { Modal, Pressable, ScrollView, Text, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { cleanAssistantText, parseUserMessage } from "@litter/transcript";
import { AgentLogo, COLOR, timeAgo } from "@/ui";
import type { Marker } from "./MarkerRail";

/** Bottom-sheet jump list of every marker in the thread, with previews.
 *  Tapping a row scrolls the timeline (still visible under the transparent
 *  modal) and dismisses the sheet over it. */
export function MarkerSheet({
  visible,
  markers,
  agent,
  onJump,
  onClose,
}: {
  visible: boolean;
  markers: Marker[];
  agent: string;
  onJump: (index: number) => void;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable className="flex-1 bg-black/50" onPress={onClose} />
      <View
        style={{ paddingBottom: insets.bottom + 16 }}
        className="rounded-t-3xl border-t border-border bg-bg-elevated px-4 pt-3"
      >
        <View className="mb-3 h-1 w-10 self-center rounded-full bg-border" />
        <View className="mb-2 flex-row items-center justify-between">
          <Text className="text-[18px] font-bold text-fg">Markers</Text>
          <Text className="text-[13px] text-fg-muted">{markers.length}</Text>
        </View>
        <ScrollView style={{ maxHeight: height * 0.6 }}>
          {markers.map((m) => {
            const user = m.type === "user_message";
            const preview = user ? userPreview(m.text, agent) : cleanAssistantText(m.text, agent);
            return (
              <Pressable
                key={m.id}
                onPress={() => {
                  onJump(m.index);
                  onClose();
                }}
                className="active:bg-surface-hover flex-row items-center gap-2.5 rounded-xl px-2 py-2.5"
              >
                {user ? (
                  <Ionicons name="person-circle-outline" size={18} color={COLOR.accent} />
                ) : (
                  <AgentLogo agent={agent} size={16} />
                )}
                <Text numberOfLines={2} className="flex-1 text-[14px] leading-[19px] text-fg">
                  {preview}
                </Text>
                <Text className="text-[11px] text-fg-faint">{timeAgo(m.ts)}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>
    </Modal>
  );
}

/** User turns can be slash-command envelopes — preview whichever piece survives. */
function userPreview(text: string, agent: string): string {
  const p = parseUserMessage(text, agent);
  if (p.text) return p.text;
  if (p.command) return `${p.command.name}${p.command.args ? ` ${p.command.args}` : ""}`;
  return text;
}
