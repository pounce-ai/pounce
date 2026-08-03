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
 * without this the dashboard falls back to ccusage's list-price estimate. An
 * org's billing report is the only supported source for what was actually
 * billed, and it needs a key the user chooses to provide. Individual (non-org)
 * accounts have no such API — for them this stays empty and Activity keeps
 * showing the estimate, plus tokens and plan quota.
 *
 * Presented as a marked-off panel rather than as more settings rows: it sits
 * directly above Diagnostics / Sync history / Help, which are navigation, and
 * looking identical to them made a piece of inline configuration read as a
 * fourth destination.
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
    // A DIRECT child of the Settings ScrollView, with no wrapper of its own:
    // that container already supplies paddingHorizontal 16 and gap 14, so any
    // padding added here would double it — the panel would sit narrower than
    // the nav cards and float further from its neighbours than they do from
    // each other. Spacing is the screen's job; this file only styles the panel.
    //
    // Deliberately unlike the bordered nav rows below it (Diagnostics / Sync
    // history / Help). Those are destinations — you tap one and leave. This is
    // configuration that lives here, so it reads as a panel with rows inside
    // rather than three more tappable cards that happen to be about money.
    <View style={s.panel}>
      <View style={s.panelHead}>
        <View style={s.panelIcon}>
          <PounceIcon name="card-outline" size={14} color={theme.colors.accent} />
        </View>
        <Text style={s.panelTitle}>Official spend</Text>
        <Text style={s.optional}>Optional</Text>
      </View>
      {/* Two jobs, in order: say what the key BUYS (a real number instead of an
        estimate), and answer the question the section otherwise provokes —
        "why only Anthropic?" It's the one agent of the four with a billing API
        we can read: Codex bills against a plan, OpenCode already reports its
        own cost, Cursor publishes nothing. The privacy line is fine print
        because it reassures rather than explains. */}
      <Text style={s.blurb}>
        Activity estimates cost at list prices. Anthropic is the only agent with a billing API — an
        org Admin key shows what you were actually charged.
      </Text>
      <View style={s.rows}>
        {devices.map((d, i) => {
          const isSet = state[d.id] === true;
          const open = editing === d.id;
          return (
            <View key={d.id} style={[s.row, i > 0 && s.rowDivided]}>
              <Pressable
                onPress={() => {
                  setEditing(open ? null : d.id);
                  setDraft("");
                }}
                style={({ pressed }) => [s.head, pressed && s.pressed]}
                hitSlop={4}
              >
                <DeviceIcon name={d.name} size={15} color={theme.colors.fgMuted} />
                <Text style={s.name} numberOfLines={1}>
                  {d.name}
                </Text>
                <View style={[s.badge, isSet && s.badgeOn]}>
                  <Text style={[s.badgeText, isSet && s.badgeTextOn]}>
                    {isSet ? "Key set" : "Not set"}
                  </Text>
                </View>
                <PounceIcon
                  name={open ? "close" : isSet ? "create-outline" : "add"}
                  size={15}
                  color={theme.colors.fgFaint}
                />
              </Pressable>
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
      <Text style={s.fineprint}>Stored on that machine. Never sent to your phone.</Text>
    </View>
  );
}

const s = StyleSheet.create((theme) => ({
  /* The accent left edge is the whole trick: it reads as a marked-off aside at
     a glance, before any text is parsed, which the neighbouring nav rows never
     do. Squarer corners (10 vs their 12) and the tinted fill keep it separate
     even in a screenshot. */
  panel: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderLeftWidth: 3,
    borderLeftColor: theme.colors.accent,
    backgroundColor: theme.colors.bgElevated,
    paddingTop: 11,
    paddingBottom: 3,
    paddingHorizontal: 12,
  },
  panelHead: { flexDirection: "row", alignItems: "center", gap: 7 },
  panelIcon: {
    width: 22,
    height: 22,
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.accentSoft,
  },
  panelTitle: { flex: 1, fontSize: 13, fontWeight: "600", color: theme.colors.fg },
  /* Says "you can ignore this" without a sentence — the section is opt-in and
     most people (individual accounts) can't use it at all. */
  optional: {
    fontSize: 10,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    color: theme.colors.fgFaint,
  },
  blurb: { marginTop: 7, fontSize: 12, lineHeight: 17, color: theme.colors.fgMuted },
  /* Reassurance, not explanation — sized and coloured to be readable but to
     lose every contest for attention against the blurb above it. */
  fineprint: { paddingBottom: 10, fontSize: 10.5, color: theme.colors.fgFaint },
  rows: { marginTop: 10 },
  /* Rows inside the panel carry no card of their own — a hairline between them
     is enough, and it stops each machine from looking like another tappable
     destination. */
  row: { paddingVertical: 2 },
  rowDivided: { borderTopWidth: 1, borderTopColor: theme.colors.border },
  head: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 9 },
  name: { flex: 1, fontSize: 13, color: theme.colors.fg },
  badge: {
    borderRadius: 999,
    backgroundColor: theme.colors.surfaceAlt,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  badgeOn: { backgroundColor: theme.colors.successSoft },
  badgeText: { fontSize: 10, fontWeight: "600", color: theme.colors.fgFaint },
  badgeTextOn: { color: theme.colors.success },
  editor: { gap: 8, paddingBottom: 11 },
  input: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.colors.borderStrong,
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
