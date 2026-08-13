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
import { useDevices } from "../../state/db/hooks";
import { fleetTunnels, updateTunnel } from "../../services/tunnelFleet";
import { fleetDrift, type TunnelStatus, versionText } from "../../services/tunnelVersions";

export function TunnelFleet() {
  const { theme } = useUnistyles();
  // The device list is the source of truth for WHICH machines exist, and this
  // section has to follow it. Loading once on mount left a removed machine
  // sitting here after it had gone from Paired — the section outliving the
  // device it describes.
  const devices = useDevices();
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

  // Keyed on the device IDS, not the array: useDevices() hands back a fresh
  // array on every heartbeat, and depending on it directly would re-probe every
  // machine each time. Adding or removing one changes this string, and only
  // then do we go and ask again.
  const deviceIds = devices.map((d) => d.id).join(",");
  useEffect(() => {
    // Cheap pass: versions come from each machine, no GitHub call. The "is
    // there anything newer" question costs a rate-limited API request per
    // machine, so it waits to be asked.
    void load(false);
  }, [load, deviceIds]);

  /**
   * The name this machine goes by everywhere else on the screen.
   *
   * A stored config's `name` is whatever it was called at pairing time — for
   * the desktop's own bridge that's `nameFromUrl()`, i.e. literally
   * "127.0.0.1", and for a machine renamed since it's the old name. The device
   * row two inches above uses the store, which carries what the bridge reports
   * itself as PLUS any rename. One screen must not call one machine two things.
   */
  const nameFor = useCallback(
    (t: TunnelStatus) => {
      const d = devices.find((x) => x.id === t.hostId);
      return d ? deviceLabel(d.id, d.name) : deviceLabel(t.hostId, t.name);
    },
    [devices],
  );

  const doUpdate = useCallback(
    async (t: TunnelStatus) => {
      setUpdating(t.hostId);
      try {
        const r = await updateTunnel(t.hostId);
        if (r.state === "ok") {
          Alert.alert("Tunnel updated", `${nameFor(t)} is now on ${r.to ?? "the latest version"}.`);
        } else if (r.state === "rolled-back") {
          Alert.alert(
            "Update rolled back",
            `${nameFor(t)} put its previous tunnel back and is still reachable. ${r.error ?? ""}`.trim(),
          );
        } else {
          Alert.alert("Update failed", r.error ?? `${nameFor(t)} couldn't update its tunnel.`);
        }
      } catch (e) {
        Alert.alert("Update failed", String((e as Error)?.message || e));
      } finally {
        setUpdating(null);
        void load(true);
      }
    },
    [load, nameFor],
  );

  const confirm = (t: TunnelStatus) =>
    Alert.alert(
      `Update ${nameFor(t)}?`,
      // Say plainly what the risk is. This is the one action in the app that
      // can make a machine unreachable, and the mitigation is worth stating.
      `Its tunnel restarts, so ${nameFor(t)} drops off for a few seconds. If the new version won't start, it puts the old one back automatically.`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Update", onPress: () => void doUpdate(t) },
      ],
    );

  // Show only machines that are still paired. A removed one lingering here
  // until the next refetch is a section outliving the thing it describes.
  const known = new Set(devices.map((d) => d.id));
  const rowsShown = rows?.filter((t) => known.has(t.hostId));
  if (!rowsShown?.length) return null;
  const drift = fleetDrift(rowsShown);

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

      {rowsShown.map((t, i) => (
        <View key={t.hostId}>
          <SettingsRow
            divided={i > 0}
            icon={t.reachable ? "git-network-outline" : "cloud-offline-outline"}
            label={nameFor(t)}
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
