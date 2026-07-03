import type { ComponentType, ReactNode } from "react";
import { Component, useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useSelector } from "@legendapp/state/react";
import { Ionicons } from "@expo/vector-icons";

type ScannerProps = { onScan: (data: string) => void; onCancel: () => void };
import { allDevices, connection$ } from "@/state/stores";
import {
  connectBridge,
  fetchPairing,
  loadBridgeConfig,
  saveBridgeConfig,
  syncLiveData,
} from "@/services/bridge";
import { savePairing } from "@/services/runtime";
import { cn, COLOR, DeviceIcon } from "@/ui";

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
  const devices = useSelector(() => allDevices());

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
      const mod = await import("@/components/QrScanner");
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

  const refresh = async () => {
    setBusy(true);
    try {
      const r = await syncLiveData();
      Alert.alert("Refreshed", `${r.devices} device${r.devices === 1 ? "" : "s"} · ${r.sessions} session${r.sessions === 1 ? "" : "s"}`);
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

        {/* Pair card */}
        <View className="gap-3 rounded-2xl border border-border bg-surface p-4">
          <Text className="text-[17px] font-semibold text-fg">Pair a device</Text>
          <Text className="text-[13px] leading-[19px] text-fg-muted">
            On your computer, show its pairing code, then scan it here. Once paired, your sessions sync automatically.
          </Text>
          <Pressable
            onPress={startScan}
            disabled={busy}
            className={cn("active:opacity-90 mt-1 h-12 flex-row items-center justify-center gap-2 rounded-xl bg-accent", busy && "opacity-50")}
          >
            <Ionicons name="qr-code-outline" size={18} color="#fff" />
            <Text className="text-[15px] font-semibold text-white">Scan pairing code</Text>
          </Pressable>
          <Pressable onPress={() => setManual((m) => !m)} className="active:opacity-60 self-center pt-1">
            <Text className="text-[13px] text-fg-muted">{manual ? "Hide manual entry" : "Enter code manually"}</Text>
          </Pressable>

          {manual ? (
            <View className="gap-2 border-t border-border pt-3">
              <Text className="text-[12px] uppercase tracking-wide text-fg-faint">Address</Text>
              <TextInput
                value={url}
                onChangeText={setUrl}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                placeholder="http://192.168.1.6:8099"
                placeholderTextColor={COLOR.fgFaint}
                className="rounded-xl bg-surface-alt px-3 py-2.5 font-mono text-[13px] text-fg"
              />
              <Text className="text-[12px] uppercase tracking-wide text-fg-faint">Code</Text>
              <TextInput
                value={token}
                onChangeText={setToken}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="pairing code"
                placeholderTextColor={COLOR.fgFaint}
                className="rounded-xl bg-surface-alt px-3 py-2.5 font-mono text-[13px] text-fg"
              />
              <Pressable
                onPress={() => doSync({ url, token })}
                disabled={busy || !url.trim() || !token.trim()}
                className={cn("active:opacity-90 mt-1 h-11 items-center justify-center rounded-xl bg-surface-alt", (busy || !url.trim() || !token.trim()) && "opacity-40")}
              >
                <Text className="text-[14px] font-semibold text-fg">Sync</Text>
              </Pressable>
            </View>
          ) : null}
        </View>

        {/* Paired devices */}
        {devices.length ? (
          <View className="gap-2">
            <Text className="text-[12px] uppercase tracking-wide text-fg-faint">Your devices</Text>
            {devices.map((d) => (
              <View key={d.id} className="flex-row items-center gap-2.5 rounded-xl border border-border bg-surface px-3 py-2.5">
                <DeviceIcon name={d.name} color={d.online ? COLOR.fg : COLOR.fgFaint} />
                <Text className="flex-1 text-[14px] font-medium text-fg">{d.name}</Text>
                <View className={cn("h-2 w-2 rounded-full", d.online ? "bg-success" : "bg-fg-faint")} />
              </View>
            ))}
            <Pressable onPress={refresh} disabled={busy} className="active:opacity-60 self-center pt-1">
              <Text className="text-[13px] text-accent">Refresh</Text>
            </Pressable>
          </View>
        ) : null}

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
    </View>
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
