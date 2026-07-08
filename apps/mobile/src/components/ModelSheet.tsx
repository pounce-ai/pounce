import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useSelector } from "@legendapp/state/react";
import { Ionicons } from "@expo/vector-icons";
import { warmModels, type ModelInfo } from "@/services/bridge";
import { cachedModels } from "@/state/stores";
import { cn, COLOR } from "@/ui";

/**
 * Searchable model picker. Renders instantly from the warmed cache
 * (`agentModels$`, prefetched on sync) and refreshes in the background — no
 * spinner once a device's models have been seen. Source is the daemon's
 * model/list, so there's no hardcoded catalog.
 */
/** Prettify a model id not in the daemon catalog: "claude-opus-4-8" → "Opus 4.8". */
function prettyModel(id: string): string {
  const s = id
    .replace(/^claude-/, "")
    .replace(/-\d{8}$/, "")
    .replace(/-(\d+)-(\d+)$/, " $1.$2")
    .replace(/-(\d+)$/, " $1");
  return s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

export function ModelSheet({
  visible,
  hostId,
  agent,
  current,
  pinned = [],
  onSelect,
  effort,
  onClose,
}: {
  visible: boolean;
  hostId: string;
  agent: string;
  /** Currently-active model id (selection or last-used) — gets a checkmark. */
  current: string | null;
  /** Model ids to always offer even if the daemon catalog omits them — e.g. the
   *  current selection and models this thread has already used, so you can
   *  always switch back. */
  pinned?: string[];
  onSelect: (id: string) => void;
  /** Reasoning-effort control, shown as a row below the models (null to hide). */
  effort?: { label: string; onPress: () => void } | null;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const [query, setQuery] = useState("");
  const [attempted, setAttempted] = useState(false);
  // Cache-first: this re-renders the moment a background warm fills the store.
  const models = useSelector(() => cachedModels(hostId, agent) ?? null);

  useEffect(() => {
    if (!visible) return;
    setQuery("");
    setAttempted(false);
    void warmModels(hostId, agent).finally(() => setAttempted(true));
  }, [visible, hostId, agent]);

  // Merge the daemon catalog with pinned ids (current + thread-used models) so
  // you can always switch back to a model even if the daemon no longer lists it.
  const merged = useMemo(() => {
    const base = models ?? [];
    const have = new Set(base.map((m) => m.id));
    const extras: ModelInfo[] = [...new Set(pinned)]
      .filter((id) => id && id !== "<synthetic>" && !have.has(id))
      .map((id) => ({ id, name: prettyModel(id), description: "Used in this thread", isDefault: false, deprecated: false }));
    return [...extras, ...base];
  }, [models, pinned]);

  const results = useMemo(() => {
    const t = query.trim().toLowerCase();
    if (!t) return merged;
    return merged.filter((m) => m.name.toLowerCase().includes(t) || m.id.toLowerCase().includes(t));
  }, [merged, query]);

  const loading = merged.length === 0 && models === null && !attempted;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable className="flex-1 bg-black/50" onPress={onClose} />
      <View
        style={{ paddingBottom: insets.bottom + 12 }}
        className="rounded-t-3xl border-t border-border bg-bg-elevated px-4 pt-3"
      >
        <View className="mb-3 h-1 w-10 self-center rounded-full bg-border" />
        <Text className="mb-2 text-[18px] font-bold text-fg">Model</Text>

        <View className="mb-2 flex-row items-center gap-2 rounded-2xl bg-surface-alt px-3">
          <Ionicons name="search" size={15} color={COLOR.fgFaint} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search models…"
            placeholderTextColor={COLOR.fgFaint}
            autoCapitalize="none"
            autoCorrect={false}
            className="h-10 flex-1 text-[15px] text-fg"
          />
        </View>

        {loading ? (
          <View className="items-center py-10">
            <ActivityIndicator color={COLOR.accent} />
          </View>
        ) : merged.length === 0 ? (
          <Text className="py-8 text-center text-[13px] text-fg-muted">
            No models reported for this agent.
          </Text>
        ) : (
          <ScrollView style={{ maxHeight: height * 0.55 }} keyboardShouldPersistTaps="handled">
            {results.map((m) => {
              const active = m.id === current;
              return (
                <Pressable
                  key={m.id}
                  onPress={() => onSelect(m.id)}
                  className="active:bg-surface-hover flex-row items-center gap-2.5 rounded-xl px-2 py-2.5"
                >
                  <View className="flex-1">
                    <View className="flex-row items-center gap-2">
                      <Text className={cn("text-[15px] font-semibold", active ? "text-accent" : "text-fg")}>
                        {m.name}
                      </Text>
                      {m.isDefault ? (
                        <Text className="rounded bg-surface-alt px-1.5 py-0.5 text-[10px] uppercase text-fg-faint">
                          default
                        </Text>
                      ) : null}
                      {m.deprecated ? (
                        <Text className="rounded bg-warning/15 px-1.5 py-0.5 text-[10px] uppercase text-warning">
                          deprecated
                        </Text>
                      ) : null}
                    </View>
                    {m.description ? (
                      <Text numberOfLines={2} className="mt-0.5 text-[12px] leading-[16px] text-fg-muted">
                        {m.description}
                      </Text>
                    ) : null}
                  </View>
                  {active ? <Ionicons name="checkmark" size={18} color={COLOR.accent} /> : null}
                </Pressable>
              );
            })}
            {results.length === 0 ? (
              <Text className="py-6 text-center text-[13px] text-fg-muted">No matches.</Text>
            ) : null}
          </ScrollView>
        )}

        {effort ? (
          <Pressable
            onPress={effort.onPress}
            className="active:opacity-80 mt-2 flex-row items-center rounded-2xl bg-surface-alt px-4 py-3.5"
          >
            <Text className="flex-1 text-[15px] font-semibold text-fg">Effort</Text>
            <Text className="text-[15px] text-fg-muted">{effort.label}</Text>
            <Ionicons name="chevron-forward" size={16} color={COLOR.fgFaint} style={{ marginLeft: 6 }} />
          </Pressable>
        ) : null}
      </View>
    </Modal>
  );
}
