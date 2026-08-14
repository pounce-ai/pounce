import { Pressable, ScrollView, Text, useWindowDimensions, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { NativeSheet } from "./NativeSheet";
import { PounceIcon } from "../ui/native/Icon";
import { cleanAssistantText, parseUserMessage } from "@pounce/transcript";
import { AgentLogo, TimeAgo } from "../ui";

/** A marked message, resolved against the current event list. */
export interface Marker {
  id: string;
  /** Index into the timeline's `events` array (for scrollToIndex). */
  index: number;
  type: "user_message" | "assistant_message";
  text: string;
  ts: string;
}

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
  const { theme } = useUnistyles();
  const { height } = useWindowDimensions();

  return (
    <NativeSheet visible={visible} onClose={onClose}>
      <View style={s.headerRow}>
        <Text style={s.headerTitle}>Markers</Text>
        <Text style={s.headerCount}>{markers.length}</Text>
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
              style={({ pressed }) => [s.row, pressed && s.rowPressed]}
            >
              {user ? (
                <PounceIcon name="person-circle-outline" size={18} color={theme.colors.accent} />
              ) : (
                <AgentLogo agent={agent} size={16} />
              )}
              <Text numberOfLines={2} style={s.preview}>
                {preview}
              </Text>
              <TimeAgo iso={m.ts} style={s.time} />
            </Pressable>
          );
        })}
      </ScrollView>
    </NativeSheet>
  );
}

/** User turns can be slash-command envelopes — preview whichever piece survives. */
function userPreview(text: string, agent: string): string {
  const p = parseUserMessage(text, agent);
  if (p.text) return p.text;
  if (p.command) return `${p.command.name}${p.command.args ? ` ${p.command.args}` : ""}`;
  return text;
}

const s = StyleSheet.create((theme) => ({
  headerRow: {
    marginBottom: 8,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  headerTitle: { fontSize: 18, fontWeight: "700", color: theme.colors.fg },
  headerCount: { fontSize: 13, color: theme.colors.fgMuted },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 10,
  },
  rowPressed: { backgroundColor: theme.colors.surfaceHover },
  preview: { flex: 1, fontSize: 14, lineHeight: 19, color: theme.colors.fg },
  time: { fontSize: 11, color: theme.colors.fgFaint },
}));
