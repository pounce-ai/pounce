/**
 * Pair a phone with this machine: shows the local bridge's pairing QR (the
 * same `pounce://connect?...` deep link the CLI prints) plus the manual URL +
 * token for typing it in. The QR SVG is rendered by the bridge itself
 * (loopback-only endpoint), so this screen just displays it.
 */
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { SvgXml } from "react-native-svg";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import {
  fetchLocalBridgeInfo,
  fetchLocalBridgeQr,
  type LocalBridgeInfo,
} from "../services/localBridge";
import { COLOR } from "@pounce/app/ui";

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
    <View className="flex-1 bg-bg">
      <View className="h-12 flex-row items-center border-b border-border px-4">
        <Text className="flex-1 text-[15px] font-semibold text-fg">Pair your phone</Text>
        <Pressable onPress={() => router.back()} className="active:opacity-60 h-8 w-8 items-center justify-center">
          <Ionicons name="close" size={18} color={COLOR.fgMuted} />
        </Pressable>
      </View>

      <View className="flex-1 items-center justify-center gap-4 px-8 py-6">
        {failed ? (
          <>
            <Ionicons name="cloud-offline-outline" size={40} color={COLOR.fgFaint} />
            <Text className="text-center text-[14px] text-fg-muted">
              The local bridge isn't reachable yet. Give it a few seconds after launch, then reopen this window.
            </Text>
          </>
        ) : !info ? (
          <ActivityIndicator color={COLOR.accent} />
        ) : (
          <>
            {qr ? (
              <View
                style={{ width: 248, height: 248 }}
                className="items-center justify-center overflow-hidden rounded-2xl bg-white"
              >
                <SvgXml xml={qr} width={216} height={216} style={{ width: 216, height: 216 }} />
              </View>
            ) : (
              <ActivityIndicator color={COLOR.accent} />
            )}
            <Text className="text-center text-[14px] text-fg-muted">
              Scan with your iPhone camera to open Pounce and connect to this Mac.
            </Text>
            <View className="items-center gap-1 rounded-xl bg-surface px-4 py-3">
              <Text className="text-[12px] text-fg-faint">or add it manually in the app</Text>
              <Text selectable className="font-mono text-[13px] text-fg">
                {info.pairUrl}
              </Text>
              <Text selectable className="font-mono text-[12px] text-fg-muted">
                token: {info.token}
              </Text>
            </View>
            <View className="flex-row items-center gap-2">
              <View
                className={`h-2 w-2 rounded-full ${info.connected ? "bg-success" : "bg-fg-faint"}`}
              />
              <Text className="text-[12px] text-fg-muted">
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
