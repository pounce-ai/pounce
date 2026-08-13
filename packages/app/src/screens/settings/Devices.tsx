/**
 * Settings → Devices: the machines this app is paired with — adding one, seeing
 * which are reachable, renaming, rescanning sessions, removing.
 */
import type { ComponentType, ReactNode } from "react";
import { Component, useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, Text, TextInput, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useRouter } from "expo-router";
import { Modal } from "../../components/AppModal";
import { PounceIcon } from "../../ui/native/Icon";
import type { Device } from "@pounce/shared";
import {
  deviceEmoji,
  deviceLabel,
  forgetDevice,
  reconcileDevices,
  setDeviceOverride,
} from "../../state/stores";
import { useDeviceOverrides, useDevices } from "../../state/db/hooks";
import {
  connectBridge,
  type DaemonInfo,
  fetchDaemon,
  fetchPairing,
  listDeviceConfigs,
  loadBridgeConfig,
  removeDeviceConfig,
  restartDaemon,
  saveBridgeConfig,
  syncLiveData,
} from "../../services/bridge";
import { savePairing } from "../../services/runtime";
import { type ParsedPairing, pairingHostName, parsePairing } from "../../services/pairing";
import { DeviceSetupCard } from "../../components/DeviceSetupCard";
import { ConnectFlow } from "../../components/ConnectFlow";
import { TunnelFleet } from "../../components/settings/TunnelFleet";
import {
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsPage,
} from "../../components/settings/primitives";
import { DeviceIcon, fmtDuration } from "../../ui";
import { deviceStatusText } from "../../services/deviceProvenance";
import { settingsTitle } from "./routes";

type ScannerProps = { onScan: (data: string) => void; onCancel: () => void };

/**
 * Daemon status for every online host, fetched together.
 *
 * Keyed on the online host IDS rather than the device array: `useDevices()`
 * hands back a fresh array on each heartbeat, and re-running this per row meant
 * every row paying its own (possibly cold, 2.5s-probing) bridge lookup.
 */
function useDaemons(devices: readonly Device[]) {
  const onlineIds = devices
    .filter((d) => d.online)
    .map((d) => d.id)
    .join(",");
  const [daemons, setDaemons] = useState<Record<string, DaemonInfo | null>>({});

  useEffect(() => {
    let cancelled = false;
    const ids = onlineIds ? onlineIds.split(",") : [];
    if (!ids.length) {
      setDaemons({});
      return;
    }
    void Promise.all(ids.map(async (id) => [id, await fetchDaemon(id)] as const)).then((pairs) => {
      if (!cancelled) setDaemons(Object.fromEntries(pairs));
    });
    return () => {
      cancelled = true;
    };
  }, [onlineIds]);

  const setDaemon = useCallback(
    (hostId: string, info: DaemonInfo | null) => setDaemons((p) => ({ ...p, [hostId]: info })),
    [],
  );
  return { daemons, setDaemon };
}

export default function DevicesScreen() {
  const router = useRouter();
  const { theme } = useUnistyles();
  const devices = useDevices();
  // Subscribe to overrides so device rows re-render when a rename/emoji applies.
  useDeviceOverrides();
  const { daemons, setDaemon } = useDaemons(devices);

  const [editing, setEditing] = useState<Device | null>(null);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [manual, setManual] = useState(false);
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [Scanner, setScanner] = useState<ComponentType<ScannerProps> | null>(null);

  useEffect(() => {
    void loadBridgeConfig().then((c) => {
      if (c) {
        setUrl(c.url);
        setToken(c.token);
      }
    });
  }, []);

  const doSync = async (cfg: ParsedPairing) => {
    setBusy(true);
    try {
      const clean = { url: cfg.url.trim().replace(/\/$/, ""), token: cfg.token.trim() };
      await saveBridgeConfig(clean);
      // A code that carries the host's tunnel identity pairs from anywhere:
      // save it BEFORE connecting so bridgeBase() can fall back to the Iroh
      // tunnel when the LAN address is unreachable (npx-on-a-server flow).
      if (cfg.nodeId) {
        await savePairing({
          nodeId: cfg.nodeId,
          token: clean.token,
          hostName: pairingHostName(cfg),
          relay: cfg.relay ?? null,
        });
      }
      const ok = await connectBridge(clean);
      if (!ok)
        throw new Error(
          "Couldn't reach that computer. Make sure it's on and you're both on the same Wi-Fi.",
        );
      // Also capture the host's direct-sync identity so it works off-Wi-Fi later.
      const pairing = await fetchPairing(clean);
      if (pairing?.nodeId) await savePairing(pairing);
      setManual(false); // collapse the manual-entry form now that it succeeded
      Alert.alert("Synced", "Your devices are connected.");
      router.navigate("/");
    } catch (e) {
      Alert.alert("Couldn't sync", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const scanFailed = () => {
    setScanning(false);
    setScanner(null);
    Alert.alert(
      "Scanning needs an update",
      "Update the app to scan codes. For now, tap “Enter code manually”.",
    );
    setManual(true);
  };

  const startScan = async () => {
    try {
      const mod = await import("../../components/QrScanner");
      setScanner(() => mod.default);
      setScanning(true);
    } catch {
      Alert.alert(
        "Scanning needs an update",
        "Update the app to scan codes. For now, tap “Enter code manually”.",
      );
      setManual(true);
    }
  };

  const onScan = (data: string) => {
    const parsed = parsePairing(data);
    if (!parsed) return; // ignore unrelated QR codes
    setScanning(false);
    void doSync(parsed);
  };

  const forget = (d: Device) => {
    Alert.alert(
      "Remove device",
      `Stop syncing ${d.name}? Its threads and sync history will be removed from this app. You can pair it again anytime.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: async () => {
            await removeDeviceConfig(d.id);
            forgetDevice(d.id);
            // reconcileDevices sweeps orphans from earlier re-pairs under other
            // URLs *and* drops the connection state (disconnect / clear active
            // host) when the removed device was the last or active one — so the
            // home screen stops reading "connected"/"All caught up".
            reconcileDevices((await listDeviceConfigs()).map((c) => c.id));
          },
        },
      ],
    );
  };

  // Feedback lands on the Sync row itself, not in an alert.
  const [syncState, setSyncState] = useState<"idle" | "syncing" | "done">("idle");
  const refresh = async () => {
    setSyncState("syncing");
    try {
      await syncLiveData();
      setSyncState("done");
      setTimeout(() => setSyncState("idle"), 2000);
    } catch {
      setSyncState("idle");
    }
  };

  if (scanning && Scanner) {
    return (
      <ScannerBoundary onFail={scanFailed}>
        <Scanner onScan={onScan} onCancel={() => setScanning(false)} />
      </ScannerBoundary>
    );
  }

  return (
    <>
      <SettingsPage title={settingsTitle("devices")}>
        {devices.length ? (
          <SettingsSection title="Paired">
            {devices.map((d, i) => (
              <View key={d.id}>
                <SettingsRow
                  divided={i > 0}
                  leading={
                    <DeviceIcon
                      name={d.name}
                      emoji={deviceEmoji(d.id)}
                      addedVia={d.addedVia}
                      color={d.online ? theme.colors.fg : theme.colors.fgFaint}
                      size={22}
                    />
                  }
                  label={deviceLabel(d.id, d.name)}
                  value={deviceStatusText(d)}
                  accessory={
                    <View style={s.rowActions}>
                      <View style={[s.dot, d.online ? s.dotOn : s.dotOff]} />
                      <Pressable
                        onPress={() => setEditing(d)}
                        hitSlop={8}
                        accessibilityLabel={`Edit ${d.name}`}
                        style={({ pressed }) => pressed && s.pressed}
                      >
                        <PounceIcon name="pencil-outline" size={17} color={theme.colors.fgFaint} />
                      </Pressable>
                      <Pressable
                        onPress={() => forget(d)}
                        hitSlop={8}
                        accessibilityLabel={`Remove ${d.name}`}
                        style={({ pressed }) => pressed && s.pressed}
                      >
                        <PounceIcon name="trash-outline" size={18} color={theme.colors.fgFaint} />
                      </Pressable>
                    </View>
                  }
                />
                <DeviceDaemon
                  hostId={d.id}
                  hostName={deviceLabel(d.id, d.name)}
                  info={d.online ? (daemons[d.id] ?? null) : null}
                  onInfo={setDaemon}
                />
              </View>
            ))}
          </SettingsSection>
        ) : null}

        {devices.length ? (
          <SettingsCard>
            <SettingsRow
              icon="sync"
              label={
                syncState === "syncing"
                  ? "Syncing…"
                  : syncState === "done"
                    ? "Up to date"
                    : "Sync now"
              }
              disabled={busy || syncState === "syncing"}
              onPress={refresh}
              accessory={
                syncState === "syncing" ? (
                  <ActivityIndicator size="small" color={theme.colors.accent} />
                ) : syncState === "done" ? (
                  <PounceIcon name="checkmark-circle" size={18} color={theme.colors.success} />
                ) : null
              }
            />
          </SettingsCard>
        ) : null}

        {/* Which tunnel each machine is on. Sits under the device list because
            it is a property OF that list — "are these in sync" is a question
            about the set, not about any one machine. */}
        {devices.length ? <TunnelFleet /> : null}

        {/* Nothing paired yet? The same self-advancing card the Home screen
            leads with — the install command, then the machine it finds. */}
        {devices.length ? null : <ConnectFlow />}

        {/* Pairing on mobile, resync/reset on desktop (platform fork). */}
        <DeviceSetupCard
          busy={busy}
          onScan={startScan}
          manual={manual}
          setManual={setManual}
          url={url}
          setUrl={setUrl}
          token={token}
          setToken={setToken}
          onSync={doSync}
        />
      </SettingsPage>
      <DeviceEditModal device={editing} onClose={() => setEditing(null)} />
    </>
  );
}

/** Per-device footer: daemon uptime and a Rescan action (re-indexes sessions
 *  when threads go missing). Silent when the host is offline or its bridge is
 *  too old to report a daemon.
 *
 *  The status itself is fetched once for ALL hosts by the screen (see
 *  useDaemons) — a fetch per row re-entered on every re-render and each one paid
 *  its own cold-cache bridge probe. */
function DeviceDaemon({
  hostId,
  hostName,
  info,
  onInfo,
}: {
  hostId: string;
  hostName: string;
  info: DaemonInfo | null;
  onInfo: (hostId: string, info: DaemonInfo | null) => void;
}) {
  const { theme } = useUnistyles();
  const [restarting, setRestarting] = useState(false);
  const setInfo = useCallback((d: DaemonInfo | null) => onInfo(hostId, d), [hostId, onInfo]);

  const doRestart = useCallback(
    async (force: boolean) => {
      setRestarting(true);
      try {
        const r = await restartDaemon(hostId, force);
        if (r.busy) {
          Alert.alert(
            "Agent is busy",
            "A reply is still being written. Rescan anyway? It will interrupt it.",
            [
              { text: "Cancel", style: "cancel" },
              { text: "Rescan anyway", style: "destructive", onPress: () => void doRestart(true) },
            ],
          );
          return;
        }
        if (r.ok) {
          setInfo(r.daemon ?? null);
          Alert.alert(
            "Daemon restarted",
            "Re-indexing sessions — pull to refresh in a few seconds.",
          );
        } else {
          Alert.alert("Couldn't restart", `Make sure ${hostName} is reachable.`);
        }
      } finally {
        setRestarting(false);
      }
    },
    [hostId, hostName, setInfo],
  );

  const confirm = () =>
    Alert.alert(
      "Rescan sessions?",
      `${hostName} will take a fresh look at its agent sessions. Takes a few seconds.`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Rescan", onPress: () => void doRestart(false) },
      ],
    );

  // Only show for hosts whose bridge actually reports a running daemon.
  if (!info?.running) return null;
  return (
    <View style={s.daemonRow}>
      <Pressable
        onPress={confirm}
        disabled={restarting}
        hitSlop={6}
        style={({ pressed }) => [s.restartPill, pressed && s.pressed]}
      >
        {restarting ? (
          <ActivityIndicator size="small" color={theme.colors.accent} />
        ) : (
          <PounceIcon name="refresh" size={13} color={theme.colors.accent} />
        )}
        <Text style={s.restartLabel}>{restarting ? "Rescanning…" : "Rescan sessions"}</Text>
      </Pressable>
      <Text style={s.uptime}>
        watching for {info.uptimeSecs != null ? fmtDuration(info.uptimeSecs) : "?"}
      </Text>
    </View>
  );
}

/** Quick-pick emoji palette for device icons — common machine / vibe glyphs. */
const DEVICE_EMOJI = [
  "💻",
  "🖥️",
  "📱",
  "🖲️",
  "☁️",
  "🐧",
  "🍎",
  "🚀",
  "🔥",
  "⚡️",
  "🐳",
  "🦊",
  "🐱",
  "🐢",
  "🌙",
  "⭐️",
];

/** Bottom-sheet editor: rename a device and optionally pick an emoji icon. */
function DeviceEditModal({ device, onClose }: { device: Device | null; onClose: () => void }) {
  const { theme } = useUnistyles();
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("");

  // Seed the inputs from the current override each time a device opens.
  useEffect(() => {
    if (!device) return;
    setName(deviceLabel(device.id, device.name));
    setEmoji(deviceEmoji(device.id) ?? "");
  }, [device]);

  if (!device) return null;

  const save = () => {
    // A name equal to the synced default clears the override rather than pinning it.
    const nextName = name.trim() === device.name.trim() ? "" : name.trim();
    setDeviceOverride(device.id, { name: nextName, emoji: emoji.trim() });
    onClose();
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={s.scrim} onPress={onClose} />
      <View style={[s.sheet, s.sheetPad]}>
        <View style={s.grabber} />
        <Text style={s.sheetTitle}>Edit device</Text>

        <View style={s.editRow}>
          <View style={s.iconBox}>
            <DeviceIcon
              name={name || device.name}
              emoji={emoji}
              color={theme.colors.fg}
              size={24}
            />
          </View>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder={device.name}
            placeholderTextColor={theme.colors.fgFaint}
            autoCapitalize="words"
            style={s.nameInput}
          />
        </View>

        <View style={s.editSection}>
          <Text style={s.editSectionLabel}>Icon</Text>
          <View style={s.emojiWrap}>
            <Pressable
              onPress={() => setEmoji("")}
              style={[s.emojiCell, emoji === "" ? s.emojiCellOn : s.emojiCellOff]}
            >
              <DeviceIcon name={device.name} color={theme.colors.fg} size={20} />
            </Pressable>
            {DEVICE_EMOJI.map((e, i) => (
              <Pressable
                key={`${e}-${i}`}
                onPress={() => setEmoji(e)}
                style={[s.emojiCell, emoji === e ? s.emojiCellOn : s.emojiCellOff]}
              >
                <Text style={s.emojiGlyph} allowFontScaling={false}>
                  {e}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>

        <Pressable onPress={save} style={({ pressed }) => [s.saveBtn, pressed && s.pressed]}>
          <Text style={s.saveLabel}>Save</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

/** Catches the "Cannot find ExpoCamera" render error in dev clients that don't
 *  have the native module yet, so the pairing flow degrades to manual entry. */
type BoundaryProps = { onFail: () => void; children: ReactNode };
class ScannerBoundary extends Component<BoundaryProps, { failed: boolean }> {
  constructor(props: BoundaryProps) {
    super(props);
    this.state = { failed: false };
  }
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch() {
    this.props.onFail();
  }
  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

const s = StyleSheet.create((theme, rt) => ({
  /** Safe-area padding in the sheet — applied natively, no re-render. */
  sheetPad: { paddingBottom: rt.insets.bottom + 16 },
  rowActions: { flexDirection: "row", alignItems: "center", gap: 12 },
  dot: { height: 8, width: 8, borderRadius: 999 },
  // Accent, not green — accent already means "live" everywhere else.
  dotOn: { backgroundColor: theme.colors.accent },
  dotOff: { backgroundColor: theme.colors.fgFaint },
  daemonRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  restartPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderRadius: 999,
    backgroundColor: theme.colors.surfaceHover,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  restartLabel: { fontSize: 13, fontWeight: "500", color: theme.colors.accent },
  uptime: { flex: 1, textAlign: "right", fontSize: 12, color: theme.colors.fgFaint },
  scrim: { flex: 1, backgroundColor: theme.colors.overlay },
  sheet: {
    gap: 16,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderCurve: "continuous",
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.bgElevated,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  grabber: {
    height: 4,
    width: 40,
    alignSelf: "center",
    borderRadius: 999,
    backgroundColor: theme.colors.border,
  },
  sheetTitle: { fontSize: 18, fontWeight: "700", color: theme.colors.fg },
  editRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  editSection: { gap: 8 },
  editSectionLabel: { fontSize: 14, fontWeight: "500", color: theme.colors.fgMuted },
  iconBox: {
    height: 48,
    width: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 12,
    borderCurve: "continuous",
    backgroundColor: theme.colors.surfaceHover,
  },
  nameInput: {
    flex: 1,
    borderRadius: 12,
    borderCurve: "continuous",
    backgroundColor: theme.colors.surfaceHover,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: theme.colors.fg,
  },
  emojiWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  emojiCell: {
    height: 44,
    width: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 12,
    borderCurve: "continuous",
    borderWidth: 1,
  },
  emojiCellOn: { borderColor: theme.colors.accent, backgroundColor: theme.colors.accentSoft },
  emojiCellOff: { borderColor: theme.colors.border, backgroundColor: theme.colors.surfaceHover },
  emojiGlyph: { fontSize: 20 },
  saveBtn: {
    marginTop: 4,
    height: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 14,
    borderCurve: "continuous",
    backgroundColor: theme.colors.accent,
  },
  saveLabel: { fontSize: 15, fontWeight: "600", color: theme.colors.onAccent },
  pressed: { opacity: 0.6 },
}));
