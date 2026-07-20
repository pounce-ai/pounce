import { useEffect, useState } from "react";
import { Modal } from "./AppModal";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PounceIcon } from "../ui/native/Icon";
import type { IoniconName } from "../ui/native/icon-map";
import { browseDirs, type DirEntry, type DirListing } from "../services/bridge";
import { COLOR } from "../ui";
import { T } from "../ui/theme";

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
      <View style={[s.root, { paddingTop: insets.top + 8 }]}>
        <View style={s.headerRow}>
          <Text style={s.headerTitle}>Choose a folder</Text>
          <Pressable onPress={onClose} style={({ pressed }) => pressed && s.pressed60}>
            <Text style={s.cancelText}>Cancel</Text>
          </Pressable>
        </View>

        {/* Current path */}
        <View style={s.pathRow}>
          <PounceIcon name="folder-open-outline" size={15} color={COLOR.accent} />
          <Text numberOfLines={1} style={s.pathText}>
            {listing ? pretty(listing.path, home) : "…"}
          </Text>
        </View>

        <ScrollView style={s.list} contentContainerStyle={{ paddingBottom: 16 }}>
          {loading ? (
            <View style={s.loadingWrap}>
              <ActivityIndicator color={COLOR.accent} />
            </View>
          ) : error ? (
            <View style={s.errorWrap}>
              <Text style={s.errorText}>
                Couldn't reach this device. Make sure Pounce Bridge is running.
              </Text>
            </View>
          ) : (
            <View style={s.entries}>
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
                <Text style={s.emptyText}>No subfolders here.</Text>
              )}
            </View>
          )}
        </ScrollView>

        {/* Pick the current folder */}
        <View style={[s.footer, { paddingBottom: insets.bottom + 8 }]}>
          <Pressable
            disabled={!listing}
            onPress={() => listing && onPick(listing.path)}
            style={({ pressed }) => [
              s.pickBtn,
              listing ? s.pickBtnEnabled : s.pickBtnDisabled,
              pressed && s.pressed80,
            ]}
          >
            <Text style={[s.pickText, listing ? s.pickTextEnabled : s.pickTextDisabled]}>
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
  icon: IoniconName;
  label: string;
  onPress: () => void;
  muted?: boolean;
  accentIcon?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [s.row, pressed && s.pressedHover]}
    >
      <PounceIcon name={icon} size={17} color={accentIcon ? COLOR.accent : COLOR.fgMuted} />
      <Text numberOfLines={1} style={[s.rowLabel, muted ? s.rowLabelMuted : s.rowLabelFg]}>
        {label}
      </Text>
      {!muted ? <PounceIcon name="chevron-forward" size={15} color={COLOR.fgFaint} /> : null}
    </Pressable>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: T.bg },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  headerTitle: { fontSize: 18, fontWeight: "700", color: T.fg },
  cancelText: { fontSize: 15, color: T.fgMuted },
  pathRow: {
    marginHorizontal: 16,
    marginBottom: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 12,
    backgroundColor: T.surfaceAlt,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  pathText: { flex: 1, fontFamily: "JetBrainsMono", fontSize: 12, color: T.fgMuted },
  list: { flex: 1, paddingHorizontal: 16 },
  loadingWrap: { alignItems: "center", paddingVertical: 64 },
  errorWrap: { alignItems: "center", paddingHorizontal: 32, paddingVertical: 64 },
  errorText: { textAlign: "center", fontSize: 13, color: T.fgMuted },
  entries: { gap: 6 },
  emptyText: { paddingHorizontal: 4, paddingVertical: 24, textAlign: "center", fontSize: 13, color: T.fgFaint },
  footer: {
    borderTopWidth: 1,
    borderColor: T.border,
    backgroundColor: T.bgElevated,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  pickBtn: { alignItems: "center", borderRadius: 999, paddingVertical: 12 },
  pickBtnEnabled: { backgroundColor: T.accent },
  pickBtnDisabled: { backgroundColor: T.surfaceAlt },
  pickText: { fontSize: 15, fontWeight: "600" },
  pickTextEnabled: { color: T.onAccent },
  pickTextDisabled: { color: T.fgFaint },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: T.border,
    backgroundColor: T.surface,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  rowLabel: { flex: 1, fontSize: 14 },
  rowLabelMuted: { color: T.fgMuted },
  rowLabelFg: { color: T.fg },
  pressed60: { opacity: 0.6 },
  pressed80: { opacity: 0.8 },
  pressedHover: { backgroundColor: T.surfaceHover },
});
