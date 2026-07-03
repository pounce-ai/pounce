import { useEffect, useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { browseDirs, type DirEntry, type DirListing } from "@/services/bridge";
import { cn, COLOR } from "@/ui";

/** Shorten an absolute path for display: home → "~", keep the tail readable. */
function pretty(path: string, home: string): string {
  const p = home && path.startsWith(home) ? "~" + path.slice(home.length) : path;
  return p === "" ? "~" : p;
}

/**
 * Full-screen folder browser. Drills through directories on `hostId` starting
 * at the device's home, and hands the chosen absolute path to `onPick`.
 */
export function FolderBrowser({
  hostId,
  visible,
  initialPath,
  onClose,
  onPick,
}: {
  hostId: string | undefined;
  visible: boolean;
  initialPath?: string | null;
  onClose: () => void;
  onPick: (path: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const [listing, setListing] = useState<DirListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const load = async (path?: string | null) => {
    if (!hostId) return;
    setLoading(true);
    setError(false);
    const res = await browseDirs(hostId, path ?? undefined);
    setListing(res);
    setError(!res);
    setLoading(false);
  };

  // Reload from the initial path each time the sheet opens.
  useEffect(() => {
    if (visible) void load(initialPath);
    else setListing(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, hostId]);

  const home = listing?.home ?? "";

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View className="flex-1 bg-bg" style={{ paddingTop: insets.top + 8 }}>
        <View className="flex-row items-center justify-between px-4 pb-2">
          <Text className="text-[18px] font-bold text-fg">Choose a folder</Text>
          <Pressable onPress={onClose} className="active:opacity-60">
            <Text className="text-[15px] text-fg-muted">Cancel</Text>
          </Pressable>
        </View>

        {/* Current path */}
        <View className="mx-4 mb-2 flex-row items-center gap-1.5 rounded-xl bg-surface-alt px-3 py-2">
          <Ionicons name="folder-open-outline" size={15} color={COLOR.accent} />
          <Text numberOfLines={1} className="flex-1 font-mono text-[12px] text-fg-muted">
            {listing ? pretty(listing.path, home) : "…"}
          </Text>
        </View>

        <ScrollView className="flex-1 px-4" contentContainerStyle={{ paddingBottom: 16 }}>
          {loading ? (
            <View className="items-center py-16">
              <ActivityIndicator color={COLOR.accent} />
            </View>
          ) : error ? (
            <View className="items-center px-8 py-16">
              <Text className="text-center text-[13px] text-fg-muted">
                Couldn't reach this device. Make sure Pounce Bridge is running.
              </Text>
            </View>
          ) : (
            <View className="gap-1.5">
              {listing?.parent != null ? (
                <Row icon="arrow-up" label=".." muted onPress={() => void load(listing.parent)} />
              ) : null}
              {listing?.entries.length ? (
                listing.entries.map((e: DirEntry) => (
                  <Row
                    key={e.path}
                    icon={e.isRepo ? "git-branch-outline" : "folder-outline"}
                    accentIcon={e.isRepo}
                    label={e.name}
                    onPress={() => void load(e.path)}
                  />
                ))
              ) : (
                <Text className="px-1 py-6 text-center text-[13px] text-fg-faint">No subfolders here.</Text>
              )}
            </View>
          )}
        </ScrollView>

        {/* Pick the current folder */}
        <View style={{ paddingBottom: insets.bottom + 8 }} className="border-t border-border bg-bg-elevated px-4 pt-3">
          <Pressable
            disabled={!listing}
            onPress={() => listing && onPick(listing.path)}
            className={cn(
              "active:opacity-80 items-center rounded-full py-3",
              listing ? "bg-accent" : "bg-surface-alt",
            )}
          >
            <Text className={cn("text-[15px] font-semibold", listing ? "text-white" : "text-fg-faint")}>
              {listing ? `Use ${pretty(listing.path, home).split("/").pop() || "this folder"}` : "Use this folder"}
            </Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

function Row({
  icon,
  label,
  onPress,
  muted,
  accentIcon,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  muted?: boolean;
  accentIcon?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      className="active:bg-surface-hover flex-row items-center gap-2.5 rounded-xl border border-border bg-surface px-3 py-3"
    >
      <Ionicons name={icon} size={17} color={accentIcon ? COLOR.accent : COLOR.fgMuted} />
      <Text numberOfLines={1} className={cn("flex-1 text-[14px]", muted ? "text-fg-muted" : "text-fg")}>
        {label}
      </Text>
      {!muted ? <Ionicons name="chevron-forward" size={15} color={COLOR.fgFaint} /> : null}
    </Pressable>
  );
}
