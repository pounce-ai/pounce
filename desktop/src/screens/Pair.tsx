/**
 * Pair a phone with this machine: shows the local bridge's pairing QR (the
 * same `pounce://connect?...` deep link the CLI prints) plus the manual URL +
 * token for typing it in. The QR SVG is rendered by the bridge itself
 * (loopback-only endpoint), so this screen just displays it.
 */
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { SvgXml } from "react-native-svg";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import {
  fetchLocalBridgeInfo,
  fetchLocalBridgeQr,
  type LocalBridgeInfo,
} from "../services/localBridge";
import { COLOR } from "@pounce/app/ui";
import { T } from "@pounce/app/ui/theme";

export default function PairScreen() {
  const router = useRouter();
  const [info, setInfo] = useState<LocalBridgeInfo | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const [i, svg] = await Promise.all([fetchLocalBridgeInfo(), fetchLocalBridgeQr()]);
      if (cancelled) return;
      if (!i) {
        setFailed(true);
        return;
      }
      setInfo(i);
      setQr(svg);
    };
    void load();
    // The phone pairing shows up as a connected device — poll so the footer
    // flips to "Phone connected" without the user doing anything.
    const t = setInterval(() => {
      void fetchLocalBridgeInfo().then((i) => {
        if (!cancelled && i) setInfo(i);
      });
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  return (
    <View style={s.root}>
      <View style={s.header}>
        <Text style={s.headerTitle}>Pair your phone</Text>
        <Pressable
          onPress={() => router.back()}
          style={({ pressed }) => [s.closeBtn, pressed && s.pressed60]}
        >
          <Ionicons name="close" size={18} color={COLOR.fgMuted} />
        </Pressable>
      </View>

      <View style={s.content}>
        {failed ? (
          <>
            <Ionicons name="cloud-offline-outline" size={40} color={COLOR.fgFaint} />
            <Text style={s.hintText}>
              The local bridge isn't reachable yet. Give it a few seconds after launch, then reopen
              this window.
            </Text>
          </>
        ) : !info ? (
          <ActivityIndicator color={COLOR.accent} />
        ) : (
          <>
            {qr ? (
              <View style={s.qrCard}>
                <SvgXml xml={qr} width={216} height={216} style={{ width: 216, height: 216 }} />
              </View>
            ) : (
              <ActivityIndicator color={COLOR.accent} />
            )}
            <Text style={s.hintText}>
              Scan with your iPhone camera to open Pounce and connect to this Mac.
            </Text>
            <View style={s.manualCard}>
              <Text style={s.manualHint}>or add it manually in the app</Text>
              <Text selectable style={s.manualUrl}>
                {info.pairUrl}
              </Text>
              <Text selectable style={s.manualToken}>
                token: {info.token}
              </Text>
            </View>
            <View style={s.statusRow}>
              <View style={[s.statusDot, info.connected ? s.dotConnected : s.dotIdle]} />
              <Text style={s.statusText}>
                {info.connected
                  ? "Phone connected"
                  : info.daemonOk
                    ? "Ready to pair"
                    : "Starting agent host…"}
              </Text>
            </View>
          </>
        )}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: T.bg },
  header: {
    height: 48,
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: 1,
    borderColor: T.border,
    paddingHorizontal: 16,
  },
  headerTitle: { flex: 1, fontSize: 15, fontWeight: "600", color: T.fg },
  closeBtn: { height: 32, width: 32, alignItems: "center", justifyContent: "center" },
  pressed60: { opacity: 0.6 },
  content: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    paddingHorizontal: 32,
    paddingVertical: 24,
  },
  hintText: { textAlign: "center", fontSize: 14, color: T.fgMuted },
  qrCard: {
    width: 248,
    height: 248,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    borderRadius: 16,
    // The QR stays on a literal white tile in both appearances so cameras scan it.
    backgroundColor: "#ffffff",
  },
  manualCard: {
    alignItems: "center",
    gap: 4,
    borderRadius: 12,
    backgroundColor: T.surface,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  manualHint: { fontSize: 12, color: T.fgFaint },
  manualUrl: { fontFamily: "JetBrainsMono", fontSize: 13, color: T.fg },
  manualToken: { fontFamily: "JetBrainsMono", fontSize: 12, color: T.fgMuted },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  statusDot: { height: 8, width: 8, borderRadius: 999 },
  dotConnected: { backgroundColor: T.success },
  dotIdle: { backgroundColor: T.fgFaint },
  statusText: { fontSize: 12, color: T.fgMuted },
});
