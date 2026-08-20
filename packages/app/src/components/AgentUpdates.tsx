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
import { ActivityIndicator, Alert, Pressable } from "react-native";
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

/**
 * Agent versions for every machine whose cards are on screen.
 *
 * Keyed by host, not global: an agent CLI is installed PER MACHINE, so two
 * paired Macs can be on different versions of the same agent and a single flat
 * list would show one machine's staleness on the other's card.
 *
 * `hostIds` is joined into a string for the effect's dependency because the
 * array is rebuilt on every sync tick — depending on the array itself re-ran
 * this every 20 seconds, which is exactly the network chatter the host-side
 * cache exists to avoid.
 */
export function useAgentUpdates(hostIds: readonly string[]) {
  const [byHost, setByHost] = useState<Record<string, AgentVersion[]>>({});
  const [busy, setBusy] = useState<Busy>({});
  const key = [...new Set(hostIds)].sort().join(",");

  const load = useCallback(async () => {
    const ids = key ? key.split(",") : [];
    await Promise.all(
      ids.map(async (id) => {
        // Gate on the contract rather than discovering absence via a 404 — an
        // older bridge simply has no agent-updates feature and stays empty.
        if (!(await hostSupports(id, "agent-updates"))) return;
        try {
          const agents = await fetchAgentVersions(id, { check: true });
          setByHost((prev) => ({ ...prev, [id]: agents }));
        } catch {
          // Unreachable is not the same as up to date; showing nothing is the
          // honest answer either way.
        }
      }),
    );
  }, [key]);

  useEffect(() => {
    void load();
  }, [load]);

  /** The version record for one agent on one machine, if we have it. */
  const versionFor = useCallback(
    (hostId: string, agent: string) => (byHost[hostId] ?? []).find((v) => v.id === agent),
    [byHost],
  );

  const update = useCallback(
    async (hostId: string, agent: AgentVersion) => {
      const slot = `${hostId}:${agent.id}`;
      setBusy((b) => ({ ...b, [slot]: true }));
      try {
        const r = await runAgentUpdate(hostId, agent.id);
        // `changed` comes from re-reading the binary on the host. An updater
        // that exits 0 and replaces nothing is common enough — a Homebrew
        // install it can't write, a version already current — that reporting it
        // as success would train people to distrust the badge.
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
        await load();
      } finally {
        setBusy((b) => ({ ...b, [slot]: false }));
      }
    },
    [load],
  );

  return { versionFor, busy, update };
}

/**
 * The badge for one agent. Renders nothing unless we can justify it.
 *
 * An ICON, not a version string. This sits in a dense row whose other contents
 * are token counts and a dollar figure, and a version number among those reads
 * as one more stat — the first draft put `↑ 0.148.0` in a filled accent pill
 * next to `1.2M  ~$4.20`, which was both the loudest thing in the row and the
 * only number in it that wasn't usage. The version belongs in the confirmation,
 * where it answers a question somebody is actually asking ("update to what?").
 *
 * Quiet by construction: an accent glyph on the card's own background, sized to
 * the text beside it. It is ambient information — nothing here is urgent, and a
 * CLI one patch behind should not out-shout the numbers the page is for.
 */
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
  const confirm = () => {
    // Ask first. This spawns a real installer on the machine, and one stray tap
    // on a row you were only reading should not start replacing binaries.
    Alert.alert(
      `Update ${version.bin}?`,
      `${version.installed} → ${version.latest}\n\nRuns \`${version.updateCommand}\` on that machine.`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Update", onPress: onUpdate },
      ],
    );
  };
  return (
    <Pressable
      onPress={confirm}
      accessibilityRole="button"
      accessibilityLabel={`Update ${version.bin} from ${version.installed} to ${version.latest}`}
      hitSlop={8}
      style={({ pressed }) => [s.badge, pressed && s.pressed]}
    >
      {/* OUTLINE, not the filled variant. Filled, this is a solid accent disc
          that reads as an alert and comes out brighter than the agent's own
          logo next to it — three rows of them made the card look like three
          warnings. A stroke keeps the affordance (a circle you can press)
          without claiming the eye first. */}
      <Ionicons name="arrow-up-circle-outline" size={14} style={s.badgeIcon} />
    </Pressable>
  );
}

const s = StyleSheet.create((theme) => ({
  // No pill, no fill: the glyph alone, on the card's own ground. A filled
  // accent chip here competed with the row's actual data for attention.
  badge: { alignItems: "center", justifyContent: "center" },
  badgeIcon: { color: theme.colors.accent },
  pressed: { opacity: 0.5 },
}));
