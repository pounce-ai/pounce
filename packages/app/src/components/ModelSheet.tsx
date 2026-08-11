import { useEffect, useMemo, useState } from "react";
import { NativeSheet } from "./NativeSheet";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { PounceIcon } from "../ui/native/Icon";
import { warmModels, type ModelInfo } from "../services/bridge";
import { shortModel } from "../components/ThreadStatusBar";
import { useAgentModels } from "../state/db/hooks";
import { AgentLogo, agentLabel, IS_DESKTOP } from "../ui";
import type { AgentId } from "@pounce/shared";

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
  agents,
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
  /**
   * Agent chips above the model list — the NEW-task case, where the agent is
   * still being chosen.
   *
   * Omitted everywhere else on purpose: a thread's agent is fixed once it
   * exists (its transcript and its worktree belong to that agent), so mid-
   * thread this sheet offers models only. Selecting here re-lists, because the
   * catalog below is keyed off the `agent` prop the caller then changes.
   */
  agents?: { available: AgentId[]; current: AgentId; onSelect: (a: AgentId) => void } | null;
  onClose: () => void;
}) {
  const { theme } = useUnistyles();
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
      .map((id) => ({
        id,
        name: prettyModel(id),
        description: "Used in this thread",
        isDefault: false,
        deprecated: false,
      }));
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

      {/* The agent, when it is still open to change. Above the list rather than
          a row beneath it, because it DECIDES that list — picking Codex under a
          list of Claude models would read as though the two were unrelated. */}
      {agents && agents.available.length > 1 ? (
        <View style={s.agentRow}>
          {agents.available.map((a) => {
            const on = a === agents.current;
            return (
              <Pressable
                key={a}
                onPress={() => agents.onSelect(a)}
                style={[s.agentChip, on ? s.agentChipOn : s.agentChipOff]}
              >
                <AgentLogo agent={a} size={14} />
                <Text style={[s.agentChipLabel, on ? s.agentChipLabelOn : null]}>
                  {agentLabel(a)}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}

      <View style={s.searchRow}>
        <PounceIcon name="search" size={15} color={theme.colors.fgFaint} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search models…"
          placeholderTextColor={theme.colors.fgFaint}
          autoCapitalize="none"
          autoCorrect={false}
          style={[s.input, IS_DESKTOP && s.inputDesktop]}
        />
      </View>

      {loading ? (
        <View style={s.loading}>
          <ActivityIndicator color={theme.colors.accent} />
        </View>
      ) : merged.length === 0 ? (
        <Text style={s.emptyText}>No models reported for this agent.</Text>
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
                    <Text style={[s.name, active ? s.nameActive : s.nameIdle]}>{m.name}</Text>
                    {m.isDefault ? <Text style={s.defaultBadge}>default</Text> : null}
                    {m.deprecated ? <Text style={s.deprecatedBadge}>deprecated</Text> : null}
                  </View>
                  {m.description ? (
                    <Text numberOfLines={2} style={s.desc}>
                      {m.description}
                    </Text>
                  ) : null}
                </View>
                {active ? (
                  <PounceIcon name="checkmark" size={18} color={theme.colors.accent} />
                ) : null}
              </Pressable>
            );
          })}
          {results.length === 0 ? <Text style={s.noMatches}>No matches.</Text> : null}
        </ScrollView>
      )}

      {effort ? (
        <Pressable
          onPress={effort.onPress}
          style={({ pressed }) => [s.effortRow, pressed && s.pressed80]}
        >
          <Text style={s.effortTitle}>Effort</Text>
          <Text style={s.effortLabel}>{effort.label}</Text>
          <PounceIcon
            name="chevron-forward"
            size={16}
            color={theme.colors.fgFaint}
            style={{ marginLeft: 6 }}
          />
        </Pressable>
      ) : null}
      {mode ? (
        <Pressable
          onPress={mode.onPress}
          style={({ pressed }) => [s.effortRow, pressed && s.pressed80]}
        >
          <Text style={s.effortTitle}>Mode</Text>
          <Text style={s.effortLabel}>{mode.label}</Text>
          <PounceIcon
            name="chevron-forward"
            size={16}
            color={theme.colors.fgFaint}
            style={{ marginLeft: 6 }}
          />
        </Pressable>
      ) : null}
    </NativeSheet>
  );
}

const s = StyleSheet.create((theme) => ({
  flex1: { flex: 1 },
  scrim: { flex: 1, backgroundColor: theme.colors.overlay },
  sheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.bgElevated,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  grabber: {
    marginBottom: 12,
    height: 4,
    width: 40,
    alignSelf: "center",
    borderRadius: 999,
    backgroundColor: theme.colors.border,
  },
  title: { marginBottom: 8, fontSize: 18, fontWeight: "700", color: theme.colors.fg },
  searchRow: {
    marginBottom: 8,
    height: 40,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: 16,
    backgroundColor: theme.colors.surfaceAlt,
    paddingHorizontal: 12,
  },
  input: { flex: 1, fontSize: 15, color: theme.colors.fg, height: 40 },
  // Desktop centers intrinsic-height inputs inside the fixed-height row —
  // see the inputH helper's comment in ui/index.tsx.
  inputDesktop: { height: "auto" as unknown as number, paddingVertical: 0 },
  loading: { alignItems: "center", paddingVertical: 40 },
  emptyText: {
    paddingVertical: 32,
    textAlign: "center",
    fontSize: 13,
    color: theme.colors.fgMuted,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 10,
  },
  rowPressed: { backgroundColor: theme.colors.surfaceHover },
  nameRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  name: { fontSize: 15, fontWeight: "600" },
  nameActive: { color: theme.colors.accent },
  nameIdle: { color: theme.colors.fg },
  defaultBadge: {
    borderRadius: 4,
    backgroundColor: theme.colors.surfaceAlt,
    paddingHorizontal: 6,
    paddingVertical: 2,
    fontSize: 10,
    textTransform: "uppercase",
    color: theme.colors.fgFaint,
  },
  deprecatedBadge: {
    borderRadius: 4,
    backgroundColor: theme.colors.warningSoft,
    paddingHorizontal: 6,
    paddingVertical: 2,
    fontSize: 10,
    textTransform: "uppercase",
    color: theme.colors.warning,
  },
  desc: { marginTop: 2, fontSize: 12, lineHeight: 16, color: theme.colors.fgMuted },
  noMatches: {
    paddingVertical: 24,
    textAlign: "center",
    fontSize: 13,
    color: theme.colors.fgMuted,
  },
  agentRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 4 },
  agentChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 11,
    paddingVertical: 6,
  },
  agentChipOn: { borderColor: theme.colors.accentLine, backgroundColor: theme.colors.accentSoft },
  agentChipOff: { borderColor: theme.colors.border, backgroundColor: theme.colors.surface },
  agentChipLabel: { fontSize: 13, fontWeight: "600", color: theme.colors.fgMuted },
  agentChipLabelOn: { color: theme.colors.accent },
  effortRow: {
    marginTop: 8,
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 16,
    backgroundColor: theme.colors.surfaceAlt,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  effortTitle: { flex: 1, fontSize: 15, fontWeight: "600", color: theme.colors.fg },
  effortLabel: { fontSize: 15, color: theme.colors.fgMuted },
  pressed80: { opacity: 0.8 },
}));
