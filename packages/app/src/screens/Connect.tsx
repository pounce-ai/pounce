import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { connectBridge } from "../services/bridge";
import { pairingHostName } from "../services/pairing";
import { savePairing } from "../services/runtime";
import { COLOR } from "../ui";
import { T } from "../ui/theme";

/**
 * Deep-link target for `pounce://connect?url=…&token=…[&node=…&relay=…&host=…]`
 * (the bridge's pairing QR). Adds the device, connects, and drops into the app
 * — no manual setup. When the link carries the host's Iroh tunnel identity
 * (`node`/`relay`), it's saved before connecting so pairing works from any
 * network — the npx/SSH flow, where the phone may never share a LAN with the
 * machine.
 */
export default function ConnectScreen() {
  const { url, token, node, relay, host } = useLocalSearchParams<{
    url?: string;
    token?: string;
    node?: string;
    relay?: string;
    host?: string;
  }>();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const done = useRef(false);

  useEffect(() => {
    if (done.current) return;
    done.current = true;
    void (async () => {
      if (!url || !token) {
        setError("This pairing link is missing its address or token.");
        return;
      }
      if (node) {
        await savePairing({
          nodeId: node,
          token,
          hostName: pairingHostName({ url, token, hostName: host }),
          relay: relay ?? null,
        });
      }
      const ok = await connectBridge({ url, token });
      if (ok) {
        const { registerForPush } = await import("../services/push");
        void registerForPush();
        router.replace("/"); // tabs home — group-free so mobile ((main) group) and the desktop shim both resolve it
      } else {
        setError(
          node
            ? "Couldn't reach that machine over Wi-Fi or its tunnel. Make sure it's on and online."
            : "Couldn't reach that machine. Make sure it's on and you're on the same network.",
        );
      }
    })();
  }, [url, token, node, relay, host]);

  return (
    <View style={s.root}>
      {error ? (
        <>
          <Text style={s.emoji}>🔌</Text>
          <Text style={s.title}>Pairing failed</Text>
          <Text style={s.body}>{error}</Text>
          <Pressable
            onPress={() => router.replace("/")}
            style={({ pressed }) => [s.continueBtn, pressed && s.pressed80]}
          >
            <Text style={s.continueLabel}>Continue anyway</Text>
          </Pressable>
        </>
      ) : (
        <>
          <ActivityIndicator color={COLOR.accent} />
          <Text style={s.pairingText} numberOfLines={1}>
            Pairing with {host || url}…
          </Text>
        </>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: T.bg,
    paddingHorizontal: 32,
  },
  emoji: { fontSize: 40 },
  title: { marginTop: 12, textAlign: "center", fontSize: 16, fontWeight: "600", color: T.fg },
  body: { marginTop: 4, textAlign: "center", fontSize: 13, color: T.fgMuted },
  continueBtn: {
    marginTop: 24,
    borderRadius: 12,
    backgroundColor: T.surfaceAlt,
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  pressed80: { opacity: 0.8 },
  continueLabel: { fontSize: 14, fontWeight: "500", color: T.fg },
  pairingText: { marginTop: 16, textAlign: "center", fontSize: 14, color: T.fgMuted },
});
