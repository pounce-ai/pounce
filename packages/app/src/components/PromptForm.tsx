/**
 * The answerable body of a generic interactive prompt — kind header, title,
 * option radios + Confirm, and a free-form reply fallback. One form answers
 * them all (trust-folder, tool permission, plan approval, AskUserQuestion, any
 * on-screen menu): pick an option and Confirm (the host moves the terminal
 * highlight there and presses Enter), or type a reply. Locks to a summary once
 * answered. Rendered inside the Timeline's inline PromptCard AND the
 * auto-presented form sheet, so the two surfaces can never drift.
 */
import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { PounceIcon } from "../ui/native/Icon";
import type { IoniconName } from "../ui/native/icon-map";
import { COLOR } from "../ui";
import { T } from "../ui/theme";

/** Header copy + icon per prompt kind — cosmetic only. */
export const PROMPT_KIND: Record<string, { label: string; icon: IoniconName }> =
  {
    trust: { label: "Trust folder", icon: "shield-checkmark-outline" },
    permission: { label: "Permission", icon: "key-outline" },
    plan: { label: "Plan", icon: "map-outline" },
    prompt: { label: "Question", icon: "help-circle-outline" },
  };

export interface PromptFormData {
  readonly promptId: string;
  readonly title: string;
  readonly kind: string;
  readonly options: readonly { readonly label: string }[];
  readonly highlighted: number;
  readonly multiSelect: boolean;
}

export function PromptForm({
  prompt,
  onRespond,
  onSendInput,
  onAnswered,
}: {
  prompt: PromptFormData;
  onRespond?: (promptId: string, optionIndex: number) => void;
  onSendInput?: (data: string) => void;
  /** Fires after the user submits (either path) — the sheet dismisses on it. */
  onAnswered?: () => void;
}) {
  const [selected, setSelected] = useState<number>(prompt.highlighted ?? 0);
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState("");
  const meta = PROMPT_KIND[prompt.kind] ?? PROMPT_KIND.prompt;

  const confirm = () => {
    if (submitted) return;
    setSubmitted(prompt.options[selected]?.label ?? "answered");
    onRespond?.(prompt.promptId, selected);
    onAnswered?.();
  };
  const sendText = () => {
    if (submitted || !text.trim()) return;
    setSubmitted(`“${text.trim()}”`);
    onSendInput?.(text + "\r");
    onAnswered?.();
  };

  return (
    <View style={s.root}>
      <View style={s.kindRow}>
        <PounceIcon name={meta.icon} size={14} color={COLOR.accent} />
        <Text style={s.kindLabel}>
          {meta.label}
        </Text>
      </View>

      {prompt.title ? (
        <Text style={s.title}>{prompt.title}</Text>
      ) : null}

      {submitted ? (
        <Text style={s.answered}>Answered: {submitted}</Text>
      ) : typing ? (
        <View style={s.typingWrap}>
          <TextInput
            value={text}
            onChangeText={setText}
            autoFocus
            placeholder="Type a reply…"
            placeholderTextColor={COLOR.fgFaint}
            onSubmitEditing={sendText}
            returnKeyType="send"
            style={s.input}
          />
          <View style={s.typingRow}>
            <Pressable
              onPress={() => setTyping(false)}
              style={({ pressed }) => [s.backBtn, pressed && s.pressed80]}
            >
              <Text style={s.backLabel}>Back to options</Text>
            </Pressable>
            <Pressable
              onPress={sendText}
              disabled={!text.trim()}
              style={({ pressed }) => [
                s.sendBtn,
                text.trim() ? s.sendBtnEnabled : s.sendBtnDisabled,
                pressed && s.pressed90,
              ]}
            >
              <Text style={[s.sendLabel, text.trim() ? s.sendLabelEnabled : s.sendLabelDisabled]}>
                Send
              </Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <>
          <View style={s.options}>
            {prompt.options.map((o, oi) => {
              const on = selected === oi;
              return (
                <Pressable
                  key={oi}
                  onPress={() => setSelected(oi)}
                  style={({ pressed }) => [
                    s.option,
                    on ? s.optionOn : s.optionOff,
                    pressed && s.pressed80,
                  ]}
                >
                  <PounceIcon
                    name={on ? "radio-button-on" : "radio-button-off"}
                    size={16}
                    color={on ? COLOR.accent : COLOR.fgFaint}
                  />
                  <Text style={[s.optionLabel, on ? s.optionLabelOn : s.optionLabelOff]}>
                    {o.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <Pressable
            onPress={confirm}
            style={({ pressed }) => [s.confirmBtn, pressed && s.pressed90]}
          >
            <Text style={s.confirmLabel}>Confirm</Text>
          </Pressable>
          {onSendInput ? (
            <Pressable
              onPress={() => setTyping(true)}
              style={({ pressed }) => [s.typeInstead, pressed && s.pressed70]}
            >
              <Text style={s.typeInsteadLabel}>Type a reply instead</Text>
            </Pressable>
          ) : null}
        </>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  root: { gap: 12 },
  kindRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  kindLabel: {
    fontSize: 12,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    color: T.accent,
  },
  title: { fontSize: 13, fontWeight: "500", color: T.fg },
  answered: { fontSize: 12, fontWeight: "500", color: T.fgMuted },
  typingWrap: { gap: 8 },
  input: {
    minHeight: 40,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: T.border,
    backgroundColor: T.surface,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 13,
    color: T.fg,
  },
  typingRow: { flexDirection: "row", gap: 8 },
  backBtn: {
    height: 36,
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
    backgroundColor: T.surfaceAlt,
  },
  backLabel: { fontSize: 13, color: T.fgMuted },
  sendBtn: { height: 36, flex: 1, alignItems: "center", justifyContent: "center", borderRadius: 8 },
  sendBtnEnabled: { backgroundColor: T.accent },
  sendBtnDisabled: { backgroundColor: T.surfaceAlt },
  sendLabel: { fontSize: 13, fontWeight: "600" },
  sendLabelEnabled: { color: T.onAccent },
  sendLabelDisabled: { color: T.fgFaint },
  options: { gap: 6 },
  option: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: 8,
    borderWidth: 1,
    padding: 10,
  },
  optionOn: { borderColor: T.accent, backgroundColor: T.accentSoft },
  optionOff: { borderColor: T.border, backgroundColor: T.surface },
  optionLabel: { flex: 1, fontSize: 13, fontWeight: "500" },
  optionLabelOn: { color: T.accent },
  optionLabelOff: { color: T.fg },
  confirmBtn: {
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
    backgroundColor: T.accent,
  },
  confirmLabel: { fontSize: 13, fontWeight: "600", color: T.onAccent },
  typeInstead: { alignItems: "center" },
  typeInsteadLabel: { fontSize: 12, color: T.fgMuted },
  pressed70: { opacity: 0.7 },
  pressed80: { opacity: 0.8 },
  pressed90: { opacity: 0.9 },
});
