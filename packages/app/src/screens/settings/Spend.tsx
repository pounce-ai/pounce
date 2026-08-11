/**
 * Settings → Official spend: an opt-in Anthropic Admin API key, per machine.
 *
 * Claude Code writes no cost to disk, so without a key Activity falls back to
 * ccusage's list-price estimate — an org's billing report is the only source for
 * what was actually billed. Individual accounts have no such API and keep the
 * estimate.
 *
 * The key lives on the HOST, not here: the bridge accepts it over /v1/config and
 * never hands it back, reporting only `adminApiKeySet`. So this screen can say
 * whether a key exists but can never display it.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import type { Device } from "@pounce/shared";
import { useDevices } from "../../state/db/hooks";
import { DeviceIcon, INPUT_TWEAKS } from "../../ui";
import { deviceLabel } from "../../state/stores";
import { fetchHostConfig, saveHostConfig } from "../../services/bridge";
import { settingsTitle } from "./routes";
import {
  SettingsCaption,
  SettingsRow,
  SettingsSection,
  SettingsPage,
} from "../../components/settings/primitives";

export default function SpendScreen() {
  const { theme } = useUnistyles();
  const devices = useDevices();
  const [state, setState] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  // Keyed on the device IDS, not the array: `useDevices()` emits a fresh array
  // on every heartbeat (online, lastSeen), which would re-fetch every host's
  // config every ~10s.
  const hostIds = useMemo(() => devices.map((d: Device) => d.id).join(","), [devices]);
  const refresh = useCallback(async () => {
    const ids = hostIds ? hostIds.split(",") : [];
    const out: Record<string, boolean> = {};
    await Promise.all(
      ids.map(async (id) => {
        const cfg = await fetchHostConfig(id);
        if (cfg) out[id] = cfg.adminApiKeySet === true;
      }),
    );
    setState(out);
  }, [hostIds]);

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

  return (
    <SettingsPage title={settingsTitle("spend")}>
      <SettingsCaption>
        Activity estimates cost at list prices. Anthropic is the only agent with a billing API — an
        org Admin key shows what you were actually charged.
      </SettingsCaption>

      {devices.length ? (
        <SettingsSection
          title="Machines"
          caption="Stored on that machine. Never sent to your phone."
        >
          {devices.map((d: Device, i: number) => {
            const isSet = state[d.id] === true;
            const open = editing === d.id;
            return (
              <View key={d.id}>
                <SettingsRow
                  divided={i > 0}
                  leading={<DeviceIcon name={d.name} size={22} color={theme.colors.fg} />}
                  label={deviceLabel(d.id, d.name)}
                  value={isSet ? "Key set" : "Not set"}
                  onPress={() => {
                    setEditing(open ? null : d.id);
                    setDraft("");
                  }}
                  accessory={
                    <Text style={isSet ? s.action : s.actionAdd}>
                      {open ? "Cancel" : isSet ? "Change" : "Add"}
                    </Text>
                  }
                />
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
                      {busy ? (
                        <ActivityIndicator size="small" color={theme.colors.fgMuted} />
                      ) : null}
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
        </SettingsSection>
      ) : (
        <SettingsCaption>
          Pair a device first — a key is stored on the machine it bills.
        </SettingsCaption>
      )}
    </SettingsPage>
  );
}

const s = StyleSheet.create((theme) => ({
  action: { fontSize: 16, color: theme.colors.accent },
  actionAdd: { fontSize: 16, fontWeight: "500", color: theme.colors.accent },
  editor: { gap: 10, paddingHorizontal: 16, paddingBottom: 16 },
  input: {
    borderRadius: 12,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderStrong,
    backgroundColor: theme.colors.bg,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontFamily: "JetBrainsMono",
    fontSize: 13,
    color: theme.colors.fg,
  },
  actions: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 8 },
  btn: { borderRadius: 10, borderCurve: "continuous", paddingHorizontal: 14, paddingVertical: 8 },
  btnPrimary: { backgroundColor: theme.colors.accent },
  btnDisabled: { opacity: 0.4 },
  btnPrimaryText: { fontSize: 14, fontWeight: "600", color: theme.colors.onAccent },
  btnDanger: { fontSize: 14, fontWeight: "600", color: theme.colors.danger },
  pressed: { opacity: 0.6 },
}));
