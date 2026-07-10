/**
 * Device-setup card on the Settings screen — mobile implementation.
 *
 * The phone pairs with a computer by scanning its bridge QR (or typing the
 * address + code). Desktop overrides this per-platform: the app runs ON the
 * agent host, so its card offers resync/reset instead — see
 * DeviceSetupCard.desktop.tsx.
 */
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { cn, COLOR, INPUT_TWEAKS } from "../ui";

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
  onScan,
  manual,
  setManual,
  url,
  setUrl,
  token,
  setToken,
  onSync,
}: DeviceSetupCardProps) {
  return (
    <View className="gap-3 rounded-2xl border border-border bg-surface p-4">
      <Text className="text-[17px] font-semibold text-fg">Pair a device</Text>
      <Text className="text-[13px] leading-[19px] text-fg-muted">
        On your computer, show its pairing code, then scan it here. Once paired, your sessions sync automatically.
      </Text>
      <Pressable
        onPress={onScan}
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
          <TextInput {...INPUT_TWEAKS}
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
