import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { connectBridge } from "../services/bridge";
import { pairingHostName } from "../services/pairing";
import { savePairing } from "../services/runtime";
import { COLOR } from "../ui";

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
        router.replace("/(app)/(tabs)");
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
    <View className="flex-1 items-center justify-center bg-bg px-8">
      {error ? (
        <>
          <Text className="text-[40px]">🔌</Text>
          <Text className="mt-3 text-center text-[16px] font-semibold text-fg">Pairing failed</Text>
          <Text className="mt-1 text-center text-[13px] text-fg-muted">{error}</Text>
          <Pressable
            onPress={() => router.replace("/(app)/(tabs)")}
            className="active:opacity-80 mt-6 rounded-xl bg-surface-alt px-5 py-2.5"
          >
            <Text className="text-[14px] font-medium text-fg">Continue anyway</Text>
          </Pressable>
        </>
      ) : (
        <>
          <ActivityIndicator color={COLOR.accent} />
          <Text className="mt-4 text-center text-[14px] text-fg-muted" numberOfLines={1}>
            Pairing with {host || url}…
          </Text>
        </>
      )}
    </View>
  );
}
