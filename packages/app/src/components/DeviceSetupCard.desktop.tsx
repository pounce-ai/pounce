/**
 * Device-setup cards — desktop implementation.
 *
 * The desktop app runs ON the agent host and pairs with its own bridge
 * automatically, so there is nothing to scan. What's left is three separate
 * subjects, and they render as three cards: this machine (resync, or reset the
 * local app data — the heartbeat re-adopts the local bridge within seconds),
 * adding another machine over SSH, and pasting an address and code by hand.
 *
 * They were one card until the last two were folded away behind an "Add another
 * machine…" link inside "This Mac" — which filed the thing you came to do under
 * the thing you didn't, and hid it.
 */
import { useState } from "react";
import { ActivityIndicator, Alert, Pressable, Text, TextInput, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { addDeviceConfig, clearBridgeConfig, syncLiveData } from "../services/bridge";
import { allCollections, clearCollection } from "../state/db/collections";
import { SettingsCard } from "./settings/primitives";
import { Chevron, Reveal } from "./Disclosure";

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
import { INPUT_TWEAKS } from "../ui";
import { useColors } from "../ui/tokens";

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
  const COLOR = useColors();
  const router = useRouter();
  const [resyncing, setResyncing] = useState(false);
  const [resyncDone, setResyncDone] = useState(false);

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

  // Three subjects, three cards. They used to be one, with everything but the
  // resync buttons hidden behind a toggle — which is fine for a detail and
  // wrong for the two things this screen exists to do.
  const thisMac = (
    <SettingsCard>
      <View style={s.body}>
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
              <ActivityIndicator size="small" color={COLOR.onAccent} />
            ) : (
              <Ionicons
                name={resyncDone ? "checkmark" : "refresh"}
                size={14}
                color={COLOR.onAccent}
              />
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
      </View>
    </SettingsCard>
  );

  // Adding a machine is its own subject. It used to live inside This Mac behind
  // an "Add another machine…" toggle, which made the headline feature of the
  // screen — Pounce sets a server up for you — something you had to already
  // know was there to find.
  const addOverSsh = (
    <SettingsCard>
      <View style={s.body}>
        <Text style={s.cardTitle}>Add a machine</Text>
        <Pressable
          onPress={() => router.push("/add-machine")}
          style={({ pressed }) => [s.sshBtn, pressed && s.pressed90]}
        >
          <Ionicons name="terminal-outline" size={15} color={COLOR.onAccent} />
          <View style={s.grow}>
            <Text style={s.sshTitle}>Set it up over SSH</Text>
            <Text style={s.sshBody}>
              Any server you can ssh into. Works from your phone afterwards too.
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={14} color={COLOR.onAccent} />
        </Pressable>
      </View>
    </SettingsCard>
  );

  // The fallback, and it reads as one: pasting is what's left when you can't
  // SSH in, or already have a code in hand. Still folded away by default — two
  // fields are noise for everyone who doesn't need them — but the fold is now
  // over this card alone rather than over the SSH route with it.
  const pasteCode = (
    <SettingsCard>
      <View style={s.body}>
        <Pressable
          onPress={() => setManual((m) => !m)}
          style={({ pressed }) => [s.rowBetween, pressed && s.pressed60]}
        >
          <View style={s.grow}>
            <Text style={s.cardTitle}>Paste an address and code</Text>
            {manual ? null : (
              <Text style={s.cardBody}>For a machine that already prints a pairing code.</Text>
            )}
          </View>
          {/* Turns rather than swapping glyph — see Disclosure.tsx. */}
          <Chevron open={manual} turn={180}>
            <Ionicons name="chevron-down" size={14} color={COLOR.fgFaint} />
          </Chevron>
        </Pressable>

        {manual ? (
          <Reveal style={s.section}>
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
          </Reveal>
        ) : null}
      </View>
    </SettingsCard>
  );

  return (
    <>
      {thisMac}
      {addOverSsh}
      {pasteCode}
    </>
  );
}

const s = StyleSheet.create((theme) => ({
  // The card itself is SettingsCard — this is only what goes inside it.
  body: { gap: 10, padding: 16 },
  cardTitle: { fontSize: 17, fontWeight: "600", color: theme.colors.fg },
  cardBody: { fontSize: 13, lineHeight: 19, color: theme.colors.fgMuted },
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
    backgroundColor: theme.colors.accent,
  },
  resyncText: { fontSize: 13, fontWeight: "600", color: theme.colors.onAccent },
  resetBtn: {
    height: 30,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderRadius: 8,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  resetText: { fontSize: 13, fontWeight: "500", color: theme.colors.danger },
  grow: { flex: 1 },
  section: { gap: 8, borderTopWidth: 1, borderColor: theme.colors.border, paddingTop: 12 },
  // The recommended route, so it wears the accent — the manual fields below are
  // the fallback, and read as one.
  sshBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: theme.colors.accent,
  },
  sshTitle: { fontSize: 13, fontWeight: "600", color: theme.colors.onAccent },
  sshBody: { marginTop: 1, fontSize: 11.5, lineHeight: 15, color: theme.colors.onAccent },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  fieldLabel: {
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    color: theme.colors.fgFaint,
  },
  input: {
    borderRadius: 12,
    backgroundColor: theme.colors.surfaceAlt,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontFamily: "JetBrainsMono",
    fontSize: 13,
    color: theme.colors.fg,
  },
  syncBtn: {
    marginTop: 4,
    height: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderRadius: 12,
    backgroundColor: theme.colors.surfaceAlt,
  },
  syncText: { fontSize: 14, fontWeight: "600", color: theme.colors.fg },
  disabled40: { opacity: 0.4 },
  disabled50: { opacity: 0.5 },
  pressed60: { opacity: 0.6 },
  pressed90: { opacity: 0.9 },
}));
