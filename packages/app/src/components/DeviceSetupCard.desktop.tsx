/**
 * Device-setup card — desktop implementation.
 *
 * The desktop app runs ON the agent host and pairs with its own bridge
 * automatically, so there is nothing to scan. This card manages this machine
 * instead: force a fresh resync, or reset local app data (device configs +
 * cached threads) — the heartbeat re-adopts the local bridge within seconds.
 * Adding ANOTHER machine's bridge stays available via manual entry.
 */
import { useState } from "react";
import { ActivityIndicator, Alert, Pressable, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { clearBridgeConfig, syncLiveData } from "../services/bridge";
import { allCollections, clearCollection } from "../state/db/collections";
import { cn, COLOR, INPUT_TWEAKS } from "../ui";

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

  const resync = async () => {
    setResyncing(true);
    setResyncDone(false);
    try {
      await syncLiveData({ fresh: true });
      setResyncDone(true);
      setTimeout(() => setResyncDone(false), 2500);
    } catch {
      Alert.alert("Resync failed", "The local agent host didn't answer. It may still be starting — try again in a few seconds.");
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
    <View className="gap-3 rounded-2xl border border-border bg-surface p-4">
      <Text className="text-[17px] font-semibold text-fg">This Mac</Text>
      <Text className="text-[13px] leading-[19px] text-fg-muted">
        Pounce runs the agent host on this machine and connects to it automatically — no pairing needed here.
      </Text>
      <View className="mt-1 flex-row gap-2">
        <Pressable
          onPress={() => void resync()}
          disabled={busy || resyncing}
          className={cn(
            "active:opacity-90 h-11 flex-1 flex-row items-center justify-center gap-2 rounded-xl bg-accent",
            (busy || resyncing) && "opacity-50",
          )}
        >
          {resyncing ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Ionicons name={resyncDone ? "checkmark" : "refresh"} size={16} color="#fff" />
          )}
          <Text className="text-[14px] font-semibold text-white">
            {resyncing ? "Resyncing…" : resyncDone ? "Up to date" : "Resync now"}
          </Text>
        </Pressable>
        <Pressable
          onPress={reset}
          disabled={busy || resyncing}
          className={cn(
            "active:opacity-90 h-11 flex-1 flex-row items-center justify-center gap-2 rounded-xl border border-danger/40 bg-danger/10",
            (busy || resyncing) && "opacity-50",
          )}
        >
          <Ionicons name="trash-outline" size={15} color={COLOR.danger} />
          <Text className="text-[14px] font-semibold text-danger">Reset app data</Text>
        </Pressable>
      </View>
      <Pressable onPress={() => setManual((m) => !m)} className="active:opacity-60 self-center pt-1">
        <Text className="text-[13px] text-fg-muted">
          {manual ? "Hide" : "Add another machine…"}
        </Text>
      </Pressable>

      {manual ? (
        <View className="gap-2 border-t border-border pt-3">
          <Text className="text-[12px] uppercase tracking-wide text-fg-faint">Address</Text>
          <TextInput {...INPUT_TWEAKS}
            value={url}
            onChangeText={setUrl}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="http://192.168.1.6:8099"
            placeholderTextColor={COLOR.fgFaint}
            className="rounded-xl bg-surface-alt px-3 py-2.5 font-mono text-[13px] text-fg"
          />
          <Text className="text-[12px] uppercase tracking-wide text-fg-faint">Code</Text>
          <TextInput {...INPUT_TWEAKS}
            value={token}
            onChangeText={setToken}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="pairing code"
            placeholderTextColor={COLOR.fgFaint}
            className="rounded-xl bg-surface-alt px-3 py-2.5 font-mono text-[13px] text-fg"
          />
          <Pressable
            onPress={() => onSync({ url, token })}
            disabled={busy || !url.trim() || !token.trim()}
            className={cn("active:opacity-90 mt-1 h-11 flex-row items-center justify-center gap-2 rounded-xl bg-surface-alt", (busy || !url.trim() || !token.trim()) && "opacity-40")}
          >
            {busy ? <ActivityIndicator size="small" color={COLOR.fgMuted} /> : null}
            <Text className="text-[14px] font-semibold text-fg">{busy ? "Connecting…" : "Sync"}</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}
