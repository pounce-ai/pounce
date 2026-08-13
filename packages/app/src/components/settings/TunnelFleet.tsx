/**
 * What tunnel every machine is running — and the button that closes a gap.
 *
 * Deliberately a fleet view rather than a per-machine detail. "Am I in sync?"
 * is a question about the set, and a version buried in each machine's own
 * screen makes the reader do the comparing; drift is then something you notice
 * by accident, months late, when one server stops being reachable.
 *
 * Nothing here happens on its own. Replacing the binary that carries a remote
 * machine's networking is an explicit act: the screen will tell you a machine
 * is behind and offer to fix it, and that's as far as it goes.
 */
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { PounceIcon } from "../../ui/native/Icon";
import { SettingsRow, SettingsSection } from "./primitives";
import { deviceLabel } from "../../state/stores";
import { fleetTunnels, updateTunnel } from "../../services/tunnelFleet";
import { fleetDrift, type TunnelStatus, versionText } from "../../services/tunnelVersions";

export function TunnelFleet() {
  const { theme } = useUnistyles();
  const [rows, setRows] = useState<TunnelStatus[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState<string | null>(null);

  const load = useCallback(async (check: boolean) => {
    if (check) setChecking(true);
    try {
      setRows(await fleetTunnels(check));
    } finally {
      setChecking(false);
    }
  }, []);

  // Cheap pass on mount: versions come from each machine, no GitHub call. The
  // "is there anything newer" question costs a rate-limited API request per
  // machine, so it waits to be asked.
  useEffect(() => {
    void load(false);
  }, [load]);

  const doUpdate = useCallback(
    async (t: TunnelStatus) => {
      setUpdating(t.hostId);
      try {
        const r = await updateTunnel(t.hostId);
        if (r.state === "ok") {
          Alert.alert("Tunnel updated", `${t.name} is now on ${r.to ?? "the latest version"}.`);
        } else if (r.state === "rolled-back") {
          Alert.alert(
            "Update rolled back",
            `${t.name} put its previous tunnel back and is still reachable. ${r.error ?? ""}`.trim(),
          );
        } else {
          Alert.alert("Update failed", r.error ?? `${t.name} couldn't update its tunnel.`);
        }
      } catch (e) {
        Alert.alert("Update failed", String((e as Error)?.message || e));
      } finally {
        setUpdating(null);
        void load(true);
      }
    },
    [load],
  );

  const confirm = (t: TunnelStatus) =>
    Alert.alert(
      `Update ${t.name}?`,
      // Say plainly what the risk is. This is the one action in the app that
      // can make a machine unreachable, and the mitigation is worth stating.
      `Its tunnel restarts, so ${t.name} drops off for a few seconds. If the new version won't start, it puts the old one back automatically.`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Update", onPress: () => void doUpdate(t) },
      ],
    );

  if (!rows?.length) return null;
  const drift = fleetDrift(rows);

  return (
    <SettingsSection title="Remote access">
      {!drift.inSync ? (
        <View style={s.banner}>
          <PounceIcon name="alert-circle-outline" size={15} color={theme.colors.warning} />
          <Text style={s.bannerText}>
            {`Your machines are on ${drift.versions.length} different tunnel versions (${drift.versions.join(", ")}).`}
          </Text>
        </View>
      ) : null}

      {rows.map((t, i) => (
        <View key={t.hostId}>
          <SettingsRow
            divided={i > 0}
            icon={t.reachable ? "git-network-outline" : "cloud-offline-outline"}
            label={deviceLabel(t.hostId, t.name)}
            value={versionText(t)}
            accessory={
              updating === t.hostId ? (
                <ActivityIndicator size="small" color={theme.colors.accent} />
              ) : t.updateAvailable ? (
                <Pressable
                  onPress={() => confirm(t)}
                  hitSlop={8}
                  style={({ pressed }) => [s.pill, pressed && s.pressed]}
                >
                  <Text style={s.pillText}>{`Update to ${t.latest}`}</Text>
                </Pressable>
              ) : null
            }
          />
          {/* A failed or rolled-back update is the thing you most need to see,
              and it must not be swallowed by a refresh that happened after it. */}
          {t.lastUpdate && t.lastUpdate.state !== "ok" && t.lastUpdate.state !== "updating" ? (
            <Text style={s.note}>{t.lastUpdate.error ?? "The last update didn't take."}</Text>
          ) : null}
        </View>
      ))}

      <SettingsRow
        divided
        icon="cloud-download-outline"
        label={checking ? "Checking…" : "Check for updates"}
        disabled={checking || !!updating}
        onPress={() => void load(true)}
        accessory={
          checking ? <ActivityIndicator size="small" color={theme.colors.accent} /> : undefined
        }
      />
    </SettingsSection>
  );
}

const s = StyleSheet.create((theme) => ({
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  bannerText: { flex: 1, color: theme.colors.fgMuted, fontSize: 13, lineHeight: 18 },
  pill: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: theme.colors.accentSoft,
  },
  pillText: { color: theme.colors.accent, fontSize: 12, fontWeight: "600" },
  pressed: { opacity: 0.6 },
  note: {
    color: theme.colors.warning,
    fontSize: 12,
    paddingHorizontal: 14,
    paddingBottom: 10,
  },
}));
