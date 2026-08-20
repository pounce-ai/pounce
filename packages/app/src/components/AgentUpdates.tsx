/**
 * "Update available" for the agent CLIs, on the Activity page.
 *
 * The bridge has always known what version of each agent was installed; nothing
 * ever said whether that was the current one, so a machine could sit months
 * behind on Claude Code or opencode in silence.
 *
 * Three things this deliberately does NOT do.
 *
 * It does not check on render. The dashboard re-syncs every 20 seconds and a
 * registry lookup per agent per sync would be rude and pointless — the host
 * caches for hours and is only asked when this mounts.
 *
 * It does not show a badge it cannot justify. `updateAvailable` is
 * `boolean | null`, and null — we could not reach the registry, or the two
 * versions cannot be honestly ranked — renders as nothing at all. A missing
 * badge costs someone an update they'd have got next week; a wrong one sends
 * them to reinstall a CLI that was already current.
 *
 * It does not claim success from an exit code. The updater's own opinion is not
 * evidence: the version is re-read from disk on the host, and an update that
 * ran cleanly while changing nothing says so.
 */
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Ionicons } from "@expo/vector-icons";
import {
  fetchAgentVersions,
  hostSupports,
  runAgentUpdate,
  type AgentVersion,
} from "../services/bridge";

/** Per-agent update state, so one row's spinner doesn't freeze the others. */
type Busy = Record<string, boolean>;

export function useAgentUpdates(hostId: string | null) {
  const [versions, setVersions] = useState<AgentVersion[]>([]);
  const [busy, setBusy] = useState<Busy>({});

  const load = useCallback(
    async (check: boolean) => {
      if (!hostId) return;
      // Gate on the contract rather than discovering absence via a 404 — an
      // older bridge simply has no agent-updates feature and this stays empty.
      if (!(await hostSupports(hostId, "agent-updates"))) return;
      try {
        setVersions(await fetchAgentVersions(hostId, { check }));
      } catch {
        // A machine that can't be reached is not a machine that's up to date;
        // showing nothing is the honest answer either way.
        setVersions([]);
      }
    },
    [hostId],
  );

  useEffect(() => {
    void load(true);
  }, [load]);

  const update = useCallback(
    async (agent: AgentVersion) => {
      if (!hostId) return;
      setBusy((b) => ({ ...b, [agent.id]: true }));
      try {
        const r = await runAgentUpdate(hostId, agent.id);
        // `changed` comes from re-reading the binary on the host. An updater
        // that exits 0 and replaces nothing is common enough — a Homebrew
        // install it can't write, a version already current behind a stale
        // cache — that reporting it as success would train people to distrust
        // the badge.
        if (r.ok && r.changed) {
          Alert.alert("Updated", `${agent.bin} is now ${r.installed ?? "up to date"}.`);
        } else if (r.ok) {
          Alert.alert(
            "Nothing changed",
            `${agent.bin} ran its updater without changing version. It may already be current, ` +
              `or installed somewhere it can't replace itself — try \`${agent.updateCommand}\` in a terminal.`,
          );
        } else {
          Alert.alert("Update failed", `Try \`${agent.updateCommand}\` in a terminal.`);
        }
        await load(true);
      } finally {
        setBusy((b) => ({ ...b, [agent.id]: false }));
      }
    },
    [hostId, load],
  );

  return { versions, busy, update };
}

/** The badge for one agent. Renders nothing unless we can justify it. */
export function AgentUpdateBadge({
  version,
  busy,
  onUpdate,
}: {
  version: AgentVersion | undefined;
  busy: boolean;
  onUpdate: () => void;
}) {
  if (busy) return <ActivityIndicator size="small" />;
  // null and false are both "say nothing" — see the header. Only a version we
  // actually ranked as behind earns pixels.
  if (!version || version.updateAvailable !== true) return null;
  return (
    <Pressable
      onPress={onUpdate}
      accessibilityRole="button"
      accessibilityLabel={`Update ${version.bin} to ${version.latest}`}
      style={({ pressed }) => [s.badge, pressed && s.pressed]}
    >
      <Ionicons name="arrow-up-circle" size={11} style={s.badgeIcon} />
      <Text style={s.badgeText}>{version.latest}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create((theme) => ({
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    borderRadius: 6,
    borderCurve: "continuous",
    backgroundColor: theme.colors.accent,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  badgeIcon: { color: theme.colors.onAccent },
  badgeText: { fontSize: 10.5, fontWeight: "600", color: theme.colors.onAccent },
  pressed: { opacity: 0.6 },
}));
