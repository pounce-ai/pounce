import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import type { Device } from "@pounce/shared";
import { PounceIcon } from "../ui/native/Icon";
import { DeviceIcon, INPUT_TWEAKS } from "../ui";
import { fetchHostConfig, saveHostConfig } from "../services/bridge";

/**
 * Opt-in Anthropic Admin API key, per machine.
 *
 * Why it's here rather than inferred: Claude Code writes no cost to disk, so
 * without this the dashboard can only show tokens. An org's billing report is
 * the supported source for real dollars, and it needs a key the user chooses to
 * provide. Individual (non-org) accounts have no such API — for them this stays
 * empty and the dashboard keeps showing tokens and plan quota.
 *
 * The key is stored on the HOST, not synced: the bridge accepts it over
 * /v1/config and never hands it back, reporting only `adminApiKeySet`. So this
 * UI can say whether a key exists but can never display it.
 */
export function AdminKeySection({ devices }: { devices: readonly Device[] }) {
  const { theme } = useUnistyles();
  const [state, setState] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const out: Record<string, boolean> = {};
    await Promise.all(
      devices.map(async (d) => {
        const cfg = await fetchHostConfig(d.id);
        if (cfg) out[d.id] = cfg.adminApiKeySet === true;
      }),
    );
    setState(out);
  }, [devices]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const apply = useCallback(async (hostId: string, key: string) => {
    setBusy(true);
    const cfg = await saveHostConfig(hostId, { adminApiKey: key });
    setBusy(false);
    if (cfg) setState((p) => ({ ...p, [hostId]: cfg.adminApiKeySet === true }));
    setEditing(null);
    setDraft("");
  }, []);

  if (!devices.length) return null;

  return (
    <View style={s.wrap}>
      <Text style={s.sectionLabel}>Official spend</Text>
      <Text style={s.blurb}>
        Pounce never prices tokens itself. Add an Anthropic Admin API key to pull your
        organization&apos;s real daily cost into Activity. Organization accounts only — the key is
        stored on that machine and is never sent to your phone.
      </Text>
      {devices.map((d) => {
        const isSet = state[d.id] === true;
        const open = editing === d.id;
        return (
          <View key={d.id} style={s.row}>
            <View style={s.head}>
              <DeviceIcon name={d.name} size={16} color={theme.colors.fgMuted} />
              <Text style={s.name}>{d.name}</Text>
              <View style={[s.badge, isSet && s.badgeOn]}>
                <Text style={[s.badgeText, isSet && s.badgeTextOn]}>
                  {isSet ? "Key set" : "Not set"}
                </Text>
              </View>
              <Pressable
                onPress={() => {
                  setEditing(open ? null : d.id);
                  setDraft("");
                }}
                hitSlop={8}
              >
                <PounceIcon
                  name={open ? "close" : isSet ? "create-outline" : "add"}
                  size={16}
                  color={theme.colors.fgMuted}
                />
              </Pressable>
            </View>
            {open ? (
              <View style={s.editor}>
                <TextInput
                  value={draft}
                  onChangeText={setDraft}
                  placeholder="sk-ant-admin01-…"
                  placeholderTextColor={theme.colors.fgFaint}
                  autoCapitalize="none"
                  autoCorrect={false}
                  // A credential: never offer it to the keyboard's learned
                  // suggestions, and mask it while typing.
                  secureTextEntry
                  style={s.input}
                  {...INPUT_TWEAKS}
                />
                <View style={s.actions}>
                  {busy ? <ActivityIndicator size="small" color={theme.colors.fgMuted} /> : null}
                  {isSet ? (
                    <Pressable
                      onPress={() => apply(d.id, "")}
                      disabled={busy}
                      style={({ pressed }) => [s.btn, pressed && s.pressed]}
                    >
                      <Text style={s.btnDanger}>Remove</Text>
                    </Pressable>
                  ) : null}
                  <Pressable
                    onPress={() => apply(d.id, draft.trim())}
                    disabled={busy || !draft.trim()}
                    style={({ pressed }) => [
                      s.btn,
                      s.btnPrimary,
                      (busy || !draft.trim()) && s.btnDisabled,
                      pressed && s.pressed,
                    ]}
                  >
                    <Text style={s.btnPrimaryText}>Save</Text>
                  </Pressable>
                </View>
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

const s = StyleSheet.create((theme) => ({
  wrap: { gap: 8, paddingHorizontal: 16, paddingTop: 20 },
  sectionLabel: {
    fontSize: 12,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    color: theme.colors.fgFaint,
  },
  blurb: { fontSize: 12, lineHeight: 17, color: theme.colors.fgMuted },
  row: {
    gap: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
    padding: 12,
  },
  head: { flexDirection: "row", alignItems: "center", gap: 8 },
  name: { flex: 1, fontSize: 14, color: theme.colors.fg },
  badge: {
    borderRadius: 999,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  badgeOn: { backgroundColor: theme.colors.successSoft },
  badgeText: { fontSize: 10, fontWeight: "600", color: theme.colors.fgFaint },
  badgeTextOn: { color: theme.colors.success },
  editor: { gap: 8 },
  input: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.bg,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontFamily: "JetBrainsMono",
    fontSize: 12,
    color: theme.colors.fg,
  },
  actions: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 8 },
  btn: { borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7 },
  btnPrimary: { backgroundColor: theme.colors.accent },
  btnDisabled: { opacity: 0.4 },
  btnPrimaryText: { fontSize: 13, fontWeight: "600", color: theme.colors.onAccent },
  btnDanger: { fontSize: 13, fontWeight: "600", color: theme.colors.danger },
  pressed: { opacity: 0.7 },
}));
