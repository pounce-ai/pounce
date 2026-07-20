import { useEffect, useMemo, useState } from "react";
import { NativeSheet } from "./NativeSheet";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { PounceIcon } from "../ui/native/Icon";
import { warmModels, type ModelInfo } from "../services/bridge";
import { shortModel } from "../components/ThreadStatusBar";
import { useAgentModels } from "../state/db/hooks";
import { COLOR, IS_DESKTOP } from "../ui";
import { T } from "../ui/theme";

/**
 * Searchable model picker. Renders instantly from the warmed cache
 * (`agentModels$`, prefetched on sync) and refreshes in the background — no
 * spinner once a device's models have been seen. Source is the daemon's
 * model/list, so there's no hardcoded catalog.
 */
/** Prettify a model id not in the daemon catalog: "claude-opus-4-8" → "Opus 4.8".
 *  Title-cases the shared short form so the two stay in lockstep. */
function prettyModel(id: string): string {
  return shortModel(id).replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

export function ModelSheet({
  visible,
  hostId,
  agent,
  current,
  pinned = [],
  onSelect,
  effort,
  mode,
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
  /** Permission-mode control, shown as a row below Effort (null to hide). */
  mode?: { label: string; onPress: () => void } | null;
  onClose: () => void;
}) {
  const { height } = useWindowDimensions();
  const [query, setQuery] = useState("");
  const [attempted, setAttempted] = useState(false);
  // Cache-first: this re-renders the moment a background warm fills the store.
  const models = useAgentModels(hostId, agent);

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
    <NativeSheet visible={visible} onClose={onClose}>
        <Text style={s.title}>Model</Text>

        <View style={s.searchRow}>
          <PounceIcon name="search" size={15} color={COLOR.fgFaint} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search models…"
            placeholderTextColor={COLOR.fgFaint}
            autoCapitalize="none"
            autoCorrect={false}
            style={[s.input, IS_DESKTOP && s.inputDesktop]}
          />
        </View>

        {loading ? (
          <View style={s.loading}>
            <ActivityIndicator color={COLOR.accent} />
          </View>
        ) : merged.length === 0 ? (
          <Text style={s.emptyText}>
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
                  style={({ pressed }) => [s.row, pressed && s.rowPressed]}
                >
                  <View style={s.flex1}>
                    <View style={s.nameRow}>
                      <Text style={[s.name, active ? s.nameActive : s.nameIdle]}>
                        {m.name}
                      </Text>
                      {m.isDefault ? (
                        <Text style={s.defaultBadge}>
                          default
                        </Text>
                      ) : null}
                      {m.deprecated ? (
                        <Text style={s.deprecatedBadge}>
                          deprecated
                        </Text>
                      ) : null}
                    </View>
                    {m.description ? (
                      <Text numberOfLines={2} style={s.desc}>
                        {m.description}
                      </Text>
                    ) : null}
                  </View>
                  {active ? <PounceIcon name="checkmark" size={18} color={COLOR.accent} /> : null}
                </Pressable>
              );
            })}
            {results.length === 0 ? (
              <Text style={s.noMatches}>No matches.</Text>
            ) : null}
          </ScrollView>
        )}

        {effort ? (
          <Pressable
            onPress={effort.onPress}
            style={({ pressed }) => [s.effortRow, pressed && s.pressed80]}
          >
            <Text style={s.effortTitle}>Effort</Text>
            <Text style={s.effortLabel}>{effort.label}</Text>
            <PounceIcon name="chevron-forward" size={16} color={COLOR.fgFaint} style={{ marginLeft: 6 }} />
          </Pressable>
        ) : null}
        {mode ? (
          <Pressable
            onPress={mode.onPress}
            style={({ pressed }) => [s.effortRow, pressed && s.pressed80]}
          >
            <Text style={s.effortTitle}>Mode</Text>
            <Text style={s.effortLabel}>{mode.label}</Text>
            <PounceIcon name="chevron-forward" size={16} color={COLOR.fgFaint} style={{ marginLeft: 6 }} />
          </Pressable>
        ) : null}
    </NativeSheet>
  );
}

const s = StyleSheet.create({
  flex1: { flex: 1 },
  scrim: { flex: 1, backgroundColor: T.overlay },
  sheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: 1,
    borderColor: T.border,
    backgroundColor: T.bgElevated,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  grabber: {
    marginBottom: 12,
    height: 4,
    width: 40,
    alignSelf: "center",
    borderRadius: 999,
    backgroundColor: T.border,
  },
  title: { marginBottom: 8, fontSize: 18, fontWeight: "700", color: T.fg },
  searchRow: {
    marginBottom: 8,
    height: 40,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: 16,
    backgroundColor: T.surfaceAlt,
    paddingHorizontal: 12,
  },
  input: { flex: 1, fontSize: 15, color: T.fg, height: 40 },
  // Desktop centers intrinsic-height inputs inside the fixed-height row —
  // see the inputH helper's comment in ui/index.tsx.
  inputDesktop: { height: "auto" as never, paddingVertical: 0 },
  loading: { alignItems: "center", paddingVertical: 40 },
  emptyText: { paddingVertical: 32, textAlign: "center", fontSize: 13, color: T.fgMuted },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 10,
  },
  rowPressed: { backgroundColor: T.surfaceHover },
  nameRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  name: { fontSize: 15, fontWeight: "600" },
  nameActive: { color: T.accent },
  nameIdle: { color: T.fg },
  defaultBadge: {
    borderRadius: 4,
    backgroundColor: T.surfaceAlt,
    paddingHorizontal: 6,
    paddingVertical: 2,
    fontSize: 10,
    textTransform: "uppercase",
    color: T.fgFaint,
  },
  deprecatedBadge: {
    borderRadius: 4,
    backgroundColor: T.warningSoft,
    paddingHorizontal: 6,
    paddingVertical: 2,
    fontSize: 10,
    textTransform: "uppercase",
    color: T.warning,
  },
  desc: { marginTop: 2, fontSize: 12, lineHeight: 16, color: T.fgMuted },
  noMatches: { paddingVertical: 24, textAlign: "center", fontSize: 13, color: T.fgMuted },
  effortRow: {
    marginTop: 8,
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 16,
    backgroundColor: T.surfaceAlt,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  effortTitle: { flex: 1, fontSize: 15, fontWeight: "600", color: T.fg },
  effortLabel: { fontSize: 15, color: T.fgMuted },
  pressed80: { opacity: 0.8 },
});
