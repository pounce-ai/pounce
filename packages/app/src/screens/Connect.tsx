import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { connectBridge } from "../services/bridge";
import { COLOR } from "../ui";

/**
 * Deep-link target for `pounce://connect?url=…&token=…` (the bridge's pairing
 * QR). Adds the device, connects, and drops into the app — no manual setup.
 */
export default function ConnectScreen() {
  const { url, token } = useLocalSearchParams<{ url?: string; token?: string }>();
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
      const ok = await connectBridge({ url, token });
      if (ok) {
        const { registerForPush } = await import("../services/push");
        void registerForPush();
        router.replace("/(app)/(tabs)");
      } else {
        setError("Couldn't reach that machine. Make sure it's on and you're on the same network.");
      }
    })();
  }, [url, token]);

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
            Pairing with {url}…
          </Text>
        </>
      )}
    </View>
  );
}
