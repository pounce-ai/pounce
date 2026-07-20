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
import { Pressable, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { cn, COLOR } from "../ui";

/** Header copy + icon per prompt kind — cosmetic only. */
export const PROMPT_KIND: Record<string, { label: string; icon: keyof typeof Ionicons.glyphMap }> =
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
    <View className="gap-3">
      <View className="flex-row items-center gap-1.5">
        <Ionicons name={meta.icon} size={14} color={COLOR.accent} />
        <Text className="text-[12px] font-semibold uppercase tracking-wide text-accent">
          {meta.label}
        </Text>
      </View>

      {prompt.title ? (
        <Text className="text-[13px] font-medium text-fg">{prompt.title}</Text>
      ) : null}

      {submitted ? (
        <Text className="text-[12px] font-medium text-fg-muted">Answered: {submitted}</Text>
      ) : typing ? (
        <View className="gap-2">
          <TextInput
            value={text}
            onChangeText={setText}
            autoFocus
            placeholder="Type a reply…"
            placeholderTextColor={COLOR.fgFaint}
            onSubmitEditing={sendText}
            returnKeyType="send"
            className="min-h-[40px] rounded-lg border border-border bg-surface px-3 py-2 text-[13px] text-fg"
          />
          <View className="flex-row gap-2">
            <Pressable
              onPress={() => setTyping(false)}
              className="active:opacity-80 h-9 flex-1 items-center justify-center rounded-lg bg-surface-alt"
            >
              <Text className="text-[13px] text-fg-muted">Back to options</Text>
            </Pressable>
            <Pressable
              onPress={sendText}
              disabled={!text.trim()}
              className={cn(
                "active:opacity-90 h-9 flex-1 items-center justify-center rounded-lg",
                text.trim() ? "bg-accent" : "bg-surface-alt",
              )}
            >
              <Text
                className={cn(
                  "text-[13px] font-semibold",
                  text.trim() ? "text-white" : "text-fg-faint",
                )}
              >
                Send
              </Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <>
          <View className="gap-1.5">
            {prompt.options.map((o, oi) => {
              const on = selected === oi;
              return (
                <Pressable
                  key={oi}
                  onPress={() => setSelected(oi)}
                  className={cn(
                    "active:opacity-80 flex-row items-center gap-2 rounded-lg border p-2.5",
                    on ? "border-accent bg-accent/15" : "border-border bg-surface",
                  )}
                >
                  <Ionicons
                    name={on ? "radio-button-on" : "radio-button-off"}
                    size={16}
                    color={on ? COLOR.accent : COLOR.fgFaint}
                  />
                  <Text
                    className={cn("flex-1 text-[13px] font-medium", on ? "text-accent" : "text-fg")}
                  >
                    {o.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <Pressable
            onPress={confirm}
            className="active:opacity-90 h-10 items-center justify-center rounded-lg bg-accent"
          >
            <Text className="text-[13px] font-semibold text-white">Confirm</Text>
          </Pressable>
          {onSendInput ? (
            <Pressable onPress={() => setTyping(true)} className="active:opacity-70 items-center">
              <Text className="text-[12px] text-fg-muted">Type a reply instead</Text>
            </Pressable>
          ) : null}
        </>
      )}
    </View>
  );
}
