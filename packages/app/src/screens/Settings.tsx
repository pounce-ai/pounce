import type { ComponentType, ReactNode } from "react";
import { Modal } from "../components/AppModal";
import { Component, useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useSelector } from "@legendapp/state/react";
import { PounceIcon } from "../ui/native/Icon";

type ScannerProps = { onScan: (data: string) => void; onCancel: () => void };
import {
  connection$,
  deviceEmoji,
  deviceLabel,
  forgetDevice,
  reconcileDevices,
  setDeviceOverride,
} from "../state/stores";
import { useDeviceOverrides, useDevices } from "../state/db/hooks";
import type { Device } from "@pounce/shared";
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
} from "../services/bridge";
import { savePairing } from "../services/runtime";
import { type ParsedPairing, pairingHostName, parsePairing } from "../services/pairing";
import { DeviceSetupCard } from "../components/DeviceSetupCard";
import { AdminKeySection } from "../components/AdminKeySection";
import { DeviceIcon, fmtDuration, IS_DESKTOP } from "../ui";
import { appearance$, setAppearance } from "../state/appearance";

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { theme } = useUnistyles();
  const status = useSelector(() => connection$.status.get());
  const appearanceMode = useSelector(() => appearance$.get());
  const devices = useDevices();
  // Subscribe to overrides so device rows re-render when a rename/emoji applies.
  useDeviceOverrides();

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

  const live = status === "connected";

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
      const mod = await import("../components/QrScanner");
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

  // Inline feedback on the Refresh control itself: "Syncing…" with a spinner
  // while the sync runs, a brief "Up to date" after — no developer-y alert.
  const [syncState, setSyncState] = useState<"idle" | "syncing" | "done">("idle");
  const refresh = async () => {
    setBusy(true);
    setSyncState("syncing");
    try {
      await syncLiveData();
      setSyncState("done");
      setTimeout(() => setSyncState("idle"), 2000);
    } catch {
      setSyncState("idle");
    } finally {
      setBusy(false);
    }
  };

  if (scanning && Scanner) {
    return (
      <ScannerBoundary onFail={scanFailed}>
        <Scanner onScan={onScan} onCancel={() => setScanning(false)} />
      </ScannerBoundary>
    );
  }

  // The ScrollView must be the screen's ROOT element on mobile: the native
  // large-title header only links (and collapses) with the first child scroll
  // view — wrapped in a View, the title never collapses and content scrolls
  // over it. Desktop keeps its chrome wrapper.
  const body = (
    <ScrollView
      style={s.scroll}
      contentInsetAdjustmentBehavior="automatic"
      // contentInsetAdjustmentBehavior is iOS-only: Android's toolbar header
      // is in-flow with NO automatic content inset, so the first row sits
      // flush against it without the explicit top padding.
      contentContainerStyle={{
        gap: 14,
        paddingTop: Platform.OS === "android" ? 16 : 0,
        paddingBottom: insets.bottom + 16,
      }}
    >
      <View style={s.statusRow}>
        <View style={[s.dot, live ? s.dotOn : s.dotOff]} />
        <Text style={s.statusText}>{live ? "Connected" : "Not connected"}</Text>
      </View>

      {/* Device setup: pairing on mobile, resync/reset on desktop (platform fork). */}
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

      {/* Paired devices */}
      {devices.length ? (
        <View style={s.section}>
          <Text style={s.sectionLabel}>Your devices</Text>
          {devices.map((d) => (
            <View key={d.id} style={s.deviceCard}>
              <View style={s.deviceRow}>
                <DeviceIcon
                  name={d.name}
                  emoji={deviceEmoji(d.id)}
                  color={d.online ? theme.colors.fg : theme.colors.fgFaint}
                  size={18}
                />
                <Text style={s.deviceName} numberOfLines={1}>
                  {deviceLabel(d.id, d.name)}
                </Text>
                <View style={[s.dot, d.online ? s.dotOn : s.dotOff]} />
                <Pressable
                  onPress={() => setEditing(d)}
                  hitSlop={8}
                  style={({ pressed }) => [s.iconBtn, pressed && s.pressed60]}
                >
                  <PounceIcon name="pencil-outline" size={15} color={theme.colors.fgFaint} />
                </Pressable>
                <Pressable
                  onPress={() => forget(d)}
                  hitSlop={8}
                  style={({ pressed }) => [s.iconBtn, pressed && s.pressed60]}
                >
                  <PounceIcon name="trash-outline" size={16} color={theme.colors.fgFaint} />
                </Pressable>
              </View>
              <DeviceDaemon hostId={d.id} hostName={deviceLabel(d.id, d.name)} online={d.online} />
            </View>
          ))}
          <Pressable
            onPress={refresh}
            disabled={busy}
            style={({ pressed }) => [s.refreshBtn, pressed && s.pressed60]}
          >
            {syncState === "syncing" ? (
              <ActivityIndicator size="small" color={theme.colors.accent} />
            ) : syncState === "done" ? (
              <PounceIcon name="checkmark-circle" size={15} color={theme.colors.success} />
            ) : null}
            <Text style={[s.refreshLabel, syncState === "idle" ? s.accentText : s.mutedText]}>
              {syncState === "syncing"
                ? "Syncing…"
                : syncState === "done"
                  ? "Up to date"
                  : "Sync now"}
            </Text>
          </Pressable>
        </View>
      ) : null}

      {/* Appearance: mobile has the sun/moon header button; desktop has no
            navigation bar, so it keeps the explicit chips. */}
      {IS_DESKTOP ? (
        <View style={s.section}>
          <Text style={s.sectionLabel}>Appearance</Text>
          <View style={s.appearanceRow}>
            {(["system", "light", "dark"] as const).map((m) => (
              <Pressable
                key={m}
                onPress={() => setAppearance(m)}
                style={({ pressed }) => [
                  s.appearanceChip,
                  appearanceMode === m ? s.appearanceChipOn : s.appearanceChipOff,
                  pressed && s.pressed80,
                ]}
              >
                <Text style={appearanceMode === m ? s.appearanceLabelOn : s.appearanceLabel}>
                  {m === "system" ? "System" : m === "light" ? "Light" : "Dark"}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}

      <AdminKeySection devices={devices} />

      {/* Diagnostics (Pounce Doctor) */}
      <Pressable
        onPress={() => router.push("/diagnostics")}
        style={({ pressed }) => [s.navRow, pressed && s.pressed80]}
      >
        <PounceIcon name="medkit-outline" size={18} color={theme.colors.fgMuted} />
        <Text style={s.navLabel}>Diagnostics</Text>
        <PounceIcon name="chevron-forward" size={15} color={theme.colors.fgFaint} />
      </Pressable>

      {/* Sync history */}
      <Pressable
        onPress={() => router.push("/sync-history")}
        style={({ pressed }) => [s.navRow, pressed && s.pressed80]}
      >
        <PounceIcon name="time-outline" size={18} color={theme.colors.fgMuted} />
        <Text style={s.navLabel}>Sync history</Text>
        <PounceIcon name="chevron-forward" size={15} color={theme.colors.fgFaint} />
      </Pressable>

      {/* Help & FAQ */}
      <Pressable
        onPress={() => router.push("/help")}
        style={({ pressed }) => [s.navRow, pressed && s.pressed80]}
      >
        <PounceIcon name="help-circle-outline" size={18} color={theme.colors.fgMuted} />
        <Text style={s.navLabel}>Help &amp; FAQ</Text>
        <PounceIcon name="chevron-forward" size={15} color={theme.colors.fgFaint} />
      </Pressable>
    </ScrollView>
  );

  if (IS_DESKTOP) {
    return (
      <View style={[s.root, { paddingTop: insets.top }]}>
        <View style={s.desktopHeader}>
          <Text style={s.title}>Settings</Text>
        </View>
        {body}
        <DeviceEditModal device={editing} onClose={() => setEditing(null)} />
      </View>
    );
  }
  return (
    <>
      {body}
      <DeviceEditModal device={editing} onClose={() => setEditing(null)} />
    </>
  );
}

/**
 * Compact per-device daemon footer inside a device card: the agent daemon's
 * uptime and a Restart action (re-indexes recent sessions when threads go
 * missing). Renders nothing when the host is offline or its bridge is too old to
 * report a daemon — so it never clutters a device that can't use it.
 */
function DeviceDaemon({
  hostId,
  hostName,
  online,
}: {
  hostId: string;
  hostName: string;
  online: boolean;
}) {
  const { theme } = useUnistyles();
  const [info, setInfo] = useState<DaemonInfo | null>(null);
  const [restarting, setRestarting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!online) {
      setInfo(null);
      return;
    }
    void fetchDaemon(hostId).then((d) => {
      if (!cancelled) setInfo(d);
    });
    return () => {
      cancelled = true;
    };
  }, [hostId, online]);

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
    [hostId, hostName],
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

  // Only show for hosts whose bridge actually reports a running daemon. The
  // Restart pill sits bottom-left — diagonally away from the edit/delete icons in
  // the row above — so the destructive controls aren't crowded together.
  if (!info?.running) return null;
  return (
    <View style={s.daemonRow}>
      <Pressable
        onPress={confirm}
        disabled={restarting}
        hitSlop={6}
        style={({ pressed }) => [s.restartPill, pressed && s.pressed70]}
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
  const insets = useSafeAreaInsets();
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
      <View style={[s.sheet, { paddingBottom: insets.bottom + 16 }]}>
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

        <View style={s.section}>
          <Text style={s.sectionLabel}>Icon</Text>
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

        <Pressable onPress={save} style={({ pressed }) => [s.saveBtn, pressed && s.pressed90]}>
          <Text style={s.saveLabel}>Save</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

/** Catches the "Cannot find ExpoCamera" render error in dev clients that don't
 *  have the native module yet, so the Sync screen degrades to manual entry. */
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

const s = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.bg },
  desktopHeader: { paddingHorizontal: 16, paddingBottom: 8, paddingTop: 4 },
  title: { fontSize: 26, fontWeight: "700", color: theme.colors.fg },
  // Also paints the page bg — on mobile this ScrollView IS the screen root.
  scroll: { flex: 1, paddingHorizontal: 16, backgroundColor: theme.colors.bg },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  statusText: { fontSize: 13, color: theme.colors.fgMuted },
  dot: { height: 8, width: 8, borderRadius: 999 },
  // Accent, not green: the sidebar's mark already uses accent-for-live, and two
  // colours for one idea on one screen is how a palette stops meaning anything.
  dotOn: { backgroundColor: theme.colors.accent },
  dotOff: { backgroundColor: theme.colors.fgFaint },
  // 14 matches the ScrollView's inter-card gap, so card-to-card spacing reads
  // as ONE rhythm across the whole screen (device cards were 8 while the
  // standalone nav cards sat 14 apart — visibly inconsistent).
  section: { gap: 14 },
  sectionLabel: {
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    color: theme.colors.fgFaint,
  },
  appearanceRow: { flexDirection: "row", gap: 8 },
  appearanceChip: {
    height: 32,
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 12,
  },
  appearanceChipOn: { borderColor: theme.colors.accent, backgroundColor: theme.colors.accentSoft },
  appearanceChipOff: { borderColor: theme.colors.border, backgroundColor: theme.colors.surfaceAlt },
  appearanceLabel: { fontSize: 13, color: theme.colors.fg },
  appearanceLabelOn: { fontSize: 13, color: theme.colors.accent },
  deviceCard: {
    overflow: "hidden",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  deviceRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  deviceName: { flex: 1, fontSize: 14, fontWeight: "500", color: theme.colors.fg },
  iconBtn: { paddingLeft: 4 },
  refreshBtn: {
    height: 28,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    alignSelf: "center",
    paddingTop: 4,
  },
  refreshLabel: { fontSize: 13 },
  accentText: { color: theme.colors.accent },
  mutedText: { color: theme.colors.fgMuted },
  navRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  navLabel: { flex: 1, fontSize: 14, fontWeight: "500", color: theme.colors.fg },
  // was border-border/60 — theme.colors.border used as-is (no 60%-alpha token)
  daemonRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  restartPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderRadius: 999,
    backgroundColor: theme.colors.surfaceAlt,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  restartLabel: { fontSize: 12, fontWeight: "500", color: theme.colors.accent },
  uptime: { flex: 1, textAlign: "right", fontSize: 11, color: theme.colors.fgFaint },
  scrim: { flex: 1, backgroundColor: theme.colors.overlay },
  sheet: {
    gap: 16,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
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
  iconBox: {
    height: 48,
    width: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 12,
    backgroundColor: theme.colors.surfaceAlt,
  },
  nameInput: {
    flex: 1,
    borderRadius: 12,
    backgroundColor: theme.colors.surfaceAlt,
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
    borderWidth: 1,
  },
  emojiCellOn: { borderColor: theme.colors.accent, backgroundColor: theme.colors.accentSoft },
  emojiCellOff: { borderColor: theme.colors.border, backgroundColor: theme.colors.surfaceAlt },
  emojiGlyph: { fontSize: 20 },
  saveBtn: {
    marginTop: 4,
    height: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 12,
    backgroundColor: theme.colors.accent,
  },
  saveLabel: { fontSize: 15, fontWeight: "600", color: theme.colors.onAccent },
  pressed60: { opacity: 0.6 },
  pressed70: { opacity: 0.7 },
  pressed80: { opacity: 0.8 },
  pressed90: { opacity: 0.9 },
}));
