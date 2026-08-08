/**
 * Device-setup card — desktop implementation.
 *
 * The desktop app runs ON the agent host and pairs with its own bridge
 * automatically, so there is nothing to scan. This card manages this machine
 * instead: force a fresh resync, or reset local app data (device configs +
 * cached threads) — the heartbeat re-adopts the local bridge within seconds.
 * Adding ANOTHER machine's bridge stays available via manual entry.
 */
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { addDeviceConfig, clearBridgeConfig, syncLiveData } from "../services/bridge";
import { allCollections, clearCollection } from "../state/db/collections";
import { Toggle } from "./Toggle";

/** This Mac's own bridge (same convention as the desktop shell's localBridge). */
const LOCAL_URL = `http://127.0.0.1:${process.env.EXPO_PUBLIC_BRIDGE_PORT ?? "8099"}`;

/** Re-adopt this Mac's bridge RIGHT NOW (mirrors the shell's ensureLocalBridge —
 *  inlined because packages/app can't import from desktop/). Without this, a
 *  reset wiped the device config and then synced against nothing: the workspace
 *  sat empty until the next heartbeat tick re-adopted (~10-20s of "is it
 *  broken?"). */
async function readoptLocalBridge(): Promise<boolean> {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 2500);
    const res = await fetch(`${LOCAL_URL}/ui`, { signal: ac.signal }).finally(() =>
      clearTimeout(timer),
    );
    if (!res.ok) return false;
    const { token } = (await res.json()) as { token?: string };
    if (!token) return false;
    await addDeviceConfig(LOCAL_URL, token);
    return true;
  } catch {
    return false;
  }
}
import {
  checkForUpdatesNow,
  isAutoUpdateEnabled,
  isUpdaterSupported,
  setAutoUpdateEnabled,
} from "../services/updater";
import { COLOR, INPUT_TWEAKS } from "../ui";
import { T } from "../ui/theme";

// Kept in sync with the mobile implementation's props (importing the type from
// "./DeviceSetupCard" would resolve back to this platform fork — circular).
export interface DeviceSetupCardProps {
  busy: boolean;
  /** Open the QR scanner (mobile) — unused by the desktop fork. */
  onScan: () => void;
  manual: boolean;
  setManual: (update: (m: boolean) => boolean) => void;
  url: string;
  setUrl: (v: string) => void;
  token: string;
  setToken: (v: string) => void;
  /** Connect to the entered address + code. */
  onSync: (p: { url: string; token: string }) => void;
}

export function DeviceSetupCard({
  busy,
  manual,
  setManual,
  url,
  setUrl,
  token,
  setToken,
  onSync,
}: DeviceSetupCardProps) {
  const [resyncing, setResyncing] = useState(false);
  const [resyncDone, setResyncDone] = useState(false);

  // Auto-update (Sparkle) — shown only where supported (macOS). The toggle
  // reflects and drives the native updater's automatic-check setting.
  const [updaterOn, setUpdaterOn] = useState(false);
  const [autoUpdate, setAutoUpdate] = useState(false);
  useEffect(() => {
    let alive = true;
    void (async () => {
      const ok = await isUpdaterSupported();
      if (!alive) return;
      setUpdaterOn(ok);
      if (ok) setAutoUpdate(await isAutoUpdateEnabled());
    })();
    return () => {
      alive = false;
    };
  }, []);
  const toggleAutoUpdate = (v: boolean) => {
    setAutoUpdate(v);
    setAutoUpdateEnabled(v);
  };

  const resync = async () => {
    setResyncing(true);
    setResyncDone(false);
    try {
      // Self-healing: if the device config is missing (e.g. right after a
      // reset), a bare sync is a silent no-op — re-adopt this Mac first.
      await readoptLocalBridge();
      await syncLiveData({ fresh: true });
      setResyncDone(true);
      setTimeout(() => setResyncDone(false), 2500);
    } catch {
      Alert.alert(
        "Resync failed",
        "The local agent host didn't answer. It may still be starting — try again in a few seconds.",
      );
    } finally {
      setResyncing(false);
    }
  };

  const reset = () => {
    Alert.alert(
      "Reset app data?",
      "Clears cached threads, devices, and pairings on this Mac. The app re-pairs with this Mac's agent host automatically; other machines need re-adding.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Reset",
          style: "destructive",
          onPress: () => {
            void (async () => {
              try {
                await clearBridgeConfig();
                for (const c of allCollections) clearCollection(c);
                // Re-adopt this Mac immediately so the workspace repopulates in
                // one beat instead of sitting empty until the next heartbeat.
                await readoptLocalBridge();
                await syncLiveData({ fresh: true }).catch(() => {});
              } catch {
                // heartbeat re-adopts the local bridge on its next tick anyway
              }
            })();
          },
        },
      ],
    );
  };

  return (
    <View style={s.card}>
      <Text style={s.cardTitle}>This Mac</Text>
      <Text style={s.cardBody}>
        Pounce runs the agent host on this machine and connects to it automatically — no pairing
        needed here.
      </Text>
      <View style={s.actionsRow}>
        <Pressable
          onPress={() => void resync()}
          disabled={busy || resyncing}
          style={({ pressed }) => [
            s.resyncBtn,
            (busy || resyncing) && s.disabled50,
            pressed && s.pressed90,
          ]}
        >
          {resyncing ? (
            <ActivityIndicator size="small" color={T.onAccent} />
          ) : (
            <Ionicons name={resyncDone ? "checkmark" : "refresh"} size={14} color={T.onAccent} />
          )}
          <Text style={s.resyncText}>
            {resyncing ? "Resyncing…" : resyncDone ? "Up to date" : "Resync now"}
          </Text>
        </Pressable>
        <View style={s.grow} />
        <Pressable
          onPress={reset}
          disabled={busy || resyncing}
          style={({ pressed }) => [
            s.resetBtn,
            (busy || resyncing) && s.disabled50,
            pressed && s.pressed90,
          ]}
        >
          <Ionicons name="trash-outline" size={14} color={COLOR.danger} />
          <Text style={s.resetText}>Reset app data</Text>
        </Pressable>
      </View>
      {updaterOn ? (
        <View style={s.section}>
          <View style={s.rowBetween}>
            <View style={s.updateCopy}>
              <Text style={s.updateTitle}>Automatic updates</Text>
              <Text style={s.updateBody}>
                Download and install new versions in the background (signature-verified).
              </Text>
            </View>
            <Toggle
              value={autoUpdate}
              onValueChange={toggleAutoUpdate}
              accessibilityLabel="Automatic updates"
            />
          </View>
          <Pressable
            onPress={() => checkForUpdatesNow()}
            style={({ pressed }) => [s.checkNow, pressed && s.pressed60]}
          >
            <Text style={s.checkNowText}>Check for updates now</Text>
          </Pressable>
        </View>
      ) : null}

      <Pressable
        onPress={() => setManual((m) => !m)}
        style={({ pressed }) => [s.manualToggle, pressed && s.pressed60]}
      >
        <Text style={s.manualToggleText}>{manual ? "Hide" : "Add another machine…"}</Text>
      </Pressable>

      {manual ? (
        <View style={s.section}>
          <Text style={s.fieldLabel}>Address</Text>
          <TextInput
            {...INPUT_TWEAKS}
            value={url}
            onChangeText={setUrl}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="http://192.168.1.6:8099"
            placeholderTextColor={COLOR.fgFaint}
            style={s.input}
          />
          <Text style={s.fieldLabel}>Code</Text>
          <TextInput
            {...INPUT_TWEAKS}
            value={token}
            onChangeText={setToken}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="pairing code"
            placeholderTextColor={COLOR.fgFaint}
            style={s.input}
          />
          <Pressable
            onPress={() => onSync({ url, token })}
            disabled={busy || !url.trim() || !token.trim()}
            style={({ pressed }) => [
              s.syncBtn,
              (busy || !url.trim() || !token.trim()) && s.disabled40,
              pressed && s.pressed90,
            ]}
          >
            {busy ? <ActivityIndicator size="small" color={COLOR.fgMuted} /> : null}
            <Text style={s.syncText}>{busy ? "Connecting…" : "Sync"}</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    gap: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: T.border,
    backgroundColor: T.surface,
    padding: 16,
  },
  cardTitle: { fontSize: 15, fontWeight: "600", color: T.fg },
  cardBody: { fontSize: 12.5, lineHeight: 18, color: T.fgMuted },
  // Desktop buttons, not phone buttons. These were two 44pt full-width slabs
  // splitting the card in half, which gave "Reset app data" — a destructive
  // action you use once, if ever — exactly the same weight as the routine one.
  // Now: content-width, 30pt, and reset is a quiet outline that has to be
  // aimed at.
  actionsRow: { marginTop: 2, flexDirection: "row", alignItems: "center", gap: 8 },
  resyncBtn: {
    height: 30,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderRadius: 8,
    paddingHorizontal: 12,
    backgroundColor: T.accent,
  },
  resyncText: { fontSize: 13, fontWeight: "600", color: T.onAccent },
  resetBtn: {
    height: 30,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderRadius: 8,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: T.border,
  },
  resetText: { fontSize: 13, fontWeight: "500", color: T.danger },
  grow: { flex: 1 },
  section: { gap: 8, borderTopWidth: 1, borderColor: T.border, paddingTop: 12 },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  updateCopy: { flex: 1, paddingRight: 12 },
  updateTitle: { fontSize: 14, fontWeight: "500", color: T.fg },
  updateBody: { fontSize: 12, lineHeight: 17, color: T.fgMuted },
  checkNow: { alignSelf: "flex-start" },
  checkNowText: { fontSize: 13, fontWeight: "500", color: T.accent },
  manualToggle: { alignSelf: "center", paddingTop: 4 },
  manualToggleText: { fontSize: 13, color: T.fgMuted },
  fieldLabel: { fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5, color: T.fgFaint },
  input: {
    borderRadius: 12,
    backgroundColor: T.surfaceAlt,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontFamily: "JetBrainsMono",
    fontSize: 13,
    color: T.fg,
  },
  syncBtn: {
    marginTop: 4,
    height: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderRadius: 12,
    backgroundColor: T.surfaceAlt,
  },
  syncText: { fontSize: 14, fontWeight: "600", color: T.fg },
  disabled40: { opacity: 0.4 },
  disabled50: { opacity: 0.5 },
  pressed60: { opacity: 0.6 },
  pressed90: { opacity: 0.9 },
});
