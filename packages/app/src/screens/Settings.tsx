import type { ComponentType, ReactNode } from "react";
import { Component, useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useSelector } from "@legendapp/state/react";
import { Ionicons } from "@expo/vector-icons";

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
import type { Device } from "@litter/shared";
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
import { DeviceSetupCard } from "../components/DeviceSetupCard";
import { cn, COLOR, DeviceIcon, fmtDuration } from "../ui";

interface Pairing { url: string; token: string }

/** Accept a scanned/pasted pairing code: a `pounce://…?url=&token=` link or
 *  raw `{ "url": …, "token": … }` JSON. */
function parsePairing(data: string): Pairing | null {
  try {
    if (data.startsWith("pounce://")) {
      const u = new URL(data);
      const url = u.searchParams.get("url");
      const token = u.searchParams.get("token");
      if (url && token) return { url, token };
    }
    const j = JSON.parse(data) as Partial<Pairing>;
    if (j.url && j.token) return { url: j.url, token: j.token };
  } catch {}
  return null;
}

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const status = useSelector(() => connection$.status.get());
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
      if (c) { setUrl(c.url); setToken(c.token); }
    });
  }, []);

  const live = status === "connected";

  const doSync = async (cfg: Pairing) => {
    setBusy(true);
    try {
      const clean = { url: cfg.url.trim().replace(/\/$/, ""), token: cfg.token.trim() };
      await saveBridgeConfig(clean);
      const ok = await connectBridge(clean);
      if (!ok) throw new Error("Couldn't reach that computer. Make sure it's on and you're both on the same Wi-Fi.");
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
    Alert.alert("Scanning needs an update", "Update the app to scan codes. For now, tap “Enter code manually”.");
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

  return (
    <View className="flex-1 bg-bg" style={{ paddingTop: insets.top }}>
      <View className="px-4 pb-2 pt-1">
        <Text className="text-[26px] font-bold text-fg">Settings</Text>
      </View>

      <ScrollView className="flex-1 px-4" contentContainerStyle={{ gap: 14, paddingBottom: insets.bottom + 120 }}>
        <View className="flex-row items-center gap-2">
          <View className={cn("h-2 w-2 rounded-full", live ? "bg-success" : "bg-fg-faint")} />
          <Text className="text-[13px] text-fg-muted">
            {live ? "Connected" : "Not connected"}
          </Text>
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
          <View className="gap-2">
            <Text className="text-[12px] uppercase tracking-wide text-fg-faint">Your devices</Text>
            {devices.map((d) => (
              <View key={d.id} className="overflow-hidden rounded-xl border border-border bg-surface">
                <View className="flex-row items-center gap-2.5 px-3 py-2.5">
                  <DeviceIcon
                    name={d.name}
                    emoji={deviceEmoji(d.id)}
                    color={d.online ? COLOR.fg : COLOR.fgFaint}
                    size={18}
                  />
                  <Text className="flex-1 text-[14px] font-medium text-fg" numberOfLines={1}>
                    {deviceLabel(d.id, d.name)}
                  </Text>
                  <View className={cn("h-2 w-2 rounded-full", d.online ? "bg-success" : "bg-fg-faint")} />
                  <Pressable onPress={() => setEditing(d)} hitSlop={8} className="active:opacity-60 pl-1">
                    <Ionicons name="pencil-outline" size={15} color={COLOR.fgFaint} />
                  </Pressable>
                  <Pressable onPress={() => forget(d)} hitSlop={8} className="active:opacity-60 pl-1">
                    <Ionicons name="trash-outline" size={16} color={COLOR.fgFaint} />
                  </Pressable>
                </View>
                <DeviceDaemon hostId={d.id} hostName={deviceLabel(d.id, d.name)} online={d.online} />
              </View>
            ))}
            <Pressable
              onPress={refresh}
              disabled={busy}
              className="active:opacity-60 h-7 flex-row items-center gap-1.5 self-center pt-1"
            >
              {syncState === "syncing" ? (
                <ActivityIndicator size="small" color={COLOR.accent} />
              ) : syncState === "done" ? (
                <Ionicons name="checkmark-circle" size={15} color={COLOR.success} />
              ) : null}
              <Text className={cn("text-[13px]", syncState === "idle" ? "text-accent" : "text-fg-muted")}>
                {syncState === "syncing" ? "Syncing…" : syncState === "done" ? "Up to date" : "Refresh"}
              </Text>
            </Pressable>
          </View>
        ) : null}

        {/* Sync history */}
        <Pressable
          onPress={() => router.push("/sync-history")}
          className="active:opacity-80 flex-row items-center gap-2.5 rounded-xl border border-border bg-surface px-3 py-3"
        >
          <Ionicons name="time-outline" size={18} color={COLOR.fgMuted} />
          <Text className="flex-1 text-[14px] font-medium text-fg">Sync history</Text>
          <Ionicons name="chevron-forward" size={15} color={COLOR.fgFaint} />
        </Pressable>

        {/* Help & FAQ */}
        <Pressable
          onPress={() => router.push("/help")}
          className="active:opacity-80 flex-row items-center gap-2.5 rounded-xl border border-border bg-surface px-3 py-3"
        >
          <Ionicons name="help-circle-outline" size={18} color={COLOR.fgMuted} />
          <Text className="flex-1 text-[14px] font-medium text-fg">Help &amp; FAQ</Text>
          <Ionicons name="chevron-forward" size={15} color={COLOR.fgFaint} />
        </Pressable>

      </ScrollView>

      <DeviceEditModal device={editing} onClose={() => setEditing(null)} />
    </View>
  );
}

/**
 * Compact per-device daemon footer inside a device card: the agent daemon's
 * uptime and a Restart action (re-indexes recent sessions when threads go
 * missing). Renders nothing when the host is offline or its bridge is too old to
 * report a daemon — so it never clutters a device that can't use it.
 */
function DeviceDaemon({ hostId, hostName, online }: { hostId: string; hostName: string; online: boolean }) {
  const [info, setInfo] = useState<DaemonInfo | null>(null);
  const [restarting, setRestarting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!online) { setInfo(null); return; }
    void fetchDaemon(hostId).then((d) => { if (!cancelled) setInfo(d); });
    return () => { cancelled = true; };
  }, [hostId, online]);

  const doRestart = useCallback(async (force: boolean) => {
    setRestarting(true);
    try {
      const r = await restartDaemon(hostId, force);
      if (r.busy) {
        Alert.alert("Agent is busy", "A turn is running. Restart anyway? It will interrupt in-progress replies.", [
          { text: "Cancel", style: "cancel" },
          { text: "Restart anyway", style: "destructive", onPress: () => void doRestart(true) },
        ]);
        return;
      }
      if (r.ok) {
        setInfo(r.daemon ?? null);
        Alert.alert("Daemon restarted", "Re-indexing sessions — pull to refresh in a few seconds.");
      } else {
        Alert.alert("Couldn't restart", `Make sure ${hostName} is reachable.`);
      }
    } finally {
      setRestarting(false);
    }
  }, [hostId, hostName]);

  const confirm = () =>
    Alert.alert("Restart agent daemon?", `On ${hostName}. Agents disconnect briefly while it re-indexes.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Restart", onPress: () => void doRestart(false) },
    ]);

  // Only show for hosts whose bridge actually reports a running daemon. The
  // Restart pill sits bottom-left — diagonally away from the edit/delete icons in
  // the row above — so the destructive controls aren't crowded together.
  if (!info?.running) return null;
  return (
    <View className="flex-row items-center gap-2 border-t border-border/60 px-3 py-2">
      <Pressable
        onPress={confirm}
        disabled={restarting}
        hitSlop={6}
        className="active:opacity-70 flex-row items-center gap-1 rounded-full bg-surface-alt px-2.5 py-1"
      >
        {restarting ? (
          <ActivityIndicator size="small" color={COLOR.accent} />
        ) : (
          <Ionicons name="refresh" size={13} color={COLOR.accent} />
        )}
        <Text className="text-[12px] font-medium text-accent">{restarting ? "Restarting…" : "Restart"}</Text>
      </Pressable>
      <Text className="flex-1 text-right text-[11px] text-fg-faint">
        daemon · up {info.uptimeSecs != null ? fmtDuration(info.uptimeSecs) : "?"}
      </Text>
    </View>
  );
}

/** Quick-pick emoji palette for device icons — common machine / vibe glyphs. */
const DEVICE_EMOJI = ["💻", "🖥️", "📱", "🖲️", "☁️", "🐧", "🍎", "🚀", "🔥", "⚡️", "🐳", "🦊", "🐱", "🐢", "🌙", "⭐️"];

/** Bottom-sheet editor: rename a device and optionally pick an emoji icon. */
function DeviceEditModal({ device, onClose }: { device: Device | null; onClose: () => void }) {
  const insets = useSafeAreaInsets();
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
      <Pressable className="flex-1 bg-black/50" onPress={onClose} />
      <View
        style={{ paddingBottom: insets.bottom + 16 }}
        className="gap-4 rounded-t-3xl border-t border-border bg-bg-elevated px-4 pt-3"
      >
        <View className="h-1 w-10 self-center rounded-full bg-border" />
        <Text className="text-[18px] font-bold text-fg">Edit device</Text>

        <View className="flex-row items-center gap-3">
          <View className="h-12 w-12 items-center justify-center rounded-xl bg-surface-alt">
            <DeviceIcon name={name || device.name} emoji={emoji} color={COLOR.fg} size={24} />
          </View>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder={device.name}
            placeholderTextColor={COLOR.fgFaint}
            autoCapitalize="words"
            className="flex-1 rounded-xl bg-surface-alt px-3 py-2.5 text-[15px] text-fg"
          />
        </View>

        <View className="gap-2">
          <Text className="text-[12px] uppercase tracking-wide text-fg-faint">Icon</Text>
          <View className="flex-row flex-wrap gap-2">
            <Pressable
              onPress={() => setEmoji("")}
              className={cn(
                "h-11 w-11 items-center justify-center rounded-xl border",
                emoji === "" ? "border-accent bg-accent/15" : "border-border bg-surface-alt",
              )}
            >
              <DeviceIcon name={device.name} color={COLOR.fg} size={20} />
            </Pressable>
            {DEVICE_EMOJI.map((e, i) => (
              <Pressable
                key={`${e}-${i}`}
                onPress={() => setEmoji(e)}
                className={cn(
                  "h-11 w-11 items-center justify-center rounded-xl border",
                  emoji === e ? "border-accent bg-accent/15" : "border-border bg-surface-alt",
                )}
              >
                <Text className="text-[20px]" allowFontScaling={false}>{e}</Text>
              </Pressable>
            ))}
          </View>
        </View>

        <Pressable
          onPress={save}
          className="active:opacity-90 mt-1 h-12 items-center justify-center rounded-xl bg-accent"
        >
          <Text className="text-[15px] font-semibold text-white">Save</Text>
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
