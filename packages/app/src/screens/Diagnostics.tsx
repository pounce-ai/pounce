/**
 * Pounce Doctor — shows the host's runtime health so a fresh or custom setup
 * can see exactly what's missing (node, the agent CLIs, git, off-LAN tunnel,
 * whether there are any sessions yet) instead of a blank app. For custom setups
 * where auto-detection fails (a shadowed/oddly-installed CLI) each agent has a
 * "Set path…" editor that pins an absolute binary path the host then honors.
 */
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { PounceIcon } from "../ui/native/Icon";
import type { DoctorReport, PounceConfig } from "@pounce/shared";
import { fetchDoctor, fetchHostConfig, saveHostConfig } from "../services/bridge";
import { useDevices } from "../state/db/hooks";

function Row({
  ok,
  title,
  detail,
  hint,
  warn,
  alwaysHint,
  children,
}: {
  ok: boolean;
  title: string;
  detail?: string | null;
  /** Shown when not ok (or when `warn`/`alwaysHint`) — how to fix it. */
  hint?: string;
  /** A soft warning (works, but limited) rather than a hard failure. */
  warn?: boolean;
  /** Show the hint even when ok (e.g. common pairing gotchas). */
  alwaysHint?: boolean;
  /** Extra content rendered under the hint (e.g. a path editor). */
  children?: React.ReactNode;
}) {
  const { theme } = useUnistyles();
  const color = ok ? theme.colors.success : warn ? theme.colors.warning : theme.colors.danger;
  const icon = ok ? "checkmark-circle" : warn ? "alert-circle" : "close-circle";
  const showHint = !ok || warn || alwaysHint;
  return (
    <View style={s.row}>
      <PounceIcon name={icon} size={18} color={color} style={{ marginTop: 1 }} />
      <View style={s.flex1}>
        <View style={s.rowHeader}>
          <Text style={s.rowTitle}>{title}</Text>
          {detail ? <Text style={s.rowDetail}>{detail}</Text> : null}
        </View>
        {showHint && hint ? <Text style={s.rowHint}>{hint}</Text> : null}
        {children}
      </View>
    </View>
  );
}

/** Pin an absolute path for a binary the host couldn't auto-detect (or to
 *  override a shadowed one). Empty + Save clears the override. */
function PathEditor({
  bin,
  detectedPath,
  override,
  onSaved,
}: {
  bin: string;
  detectedPath?: string | null;
  override?: string | null;
  onSaved: (bin: string, value: string) => Promise<void>;
}) {
  const { theme } = useUnistyles();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(override ?? "");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await onSaved(bin, draft.trim());
      setOpen(false);
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <Pressable
        onPress={() => {
          setDraft(override ?? "");
          setOpen(true);
        }}
        style={({ pressed }) => [s.editLink, pressed && s.pressed60]}
      >
        <PounceIcon name="create-outline" size={13} color={theme.colors.accent} />
        <Text style={s.editLinkText}>
          {override ? "Change path" : "Set path manually"}
        </Text>
      </Pressable>
    );
  }

  return (
    <View style={s.editor}>
      <Text style={s.editorHint}>
        Absolute path to the <Text style={s.editorBin}>{bin}</Text> binary
        {detectedPath ? ` (auto-detected: ${detectedPath})` : ""}.
      </Text>
      <TextInput
        value={draft}
        onChangeText={setDraft}
        placeholder={`/path/to/${bin}`}
        placeholderTextColor={theme.colors.fgFaint}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        style={s.editorInput}
      />
      <View style={s.editorActions}>
        <Pressable
          onPress={save}
          disabled={saving}
          style={({ pressed }) => [s.saveBtn, pressed && s.pressed80, { opacity: saving ? 0.6 : 1 }]}
        >
          <Text style={s.saveText}>{saving ? "Saving…" : "Save"}</Text>
        </Pressable>
        <Pressable
          onPress={() => setOpen(false)}
          disabled={saving}
          style={({ pressed }) => [s.smallBtn, pressed && s.pressed60]}
        >
          <Text style={s.cancelText}>Cancel</Text>
        </Pressable>
        {override ? (
          <Pressable
            onPress={async () => {
              setDraft("");
              setSaving(true);
              try {
                await onSaved(bin, "");
                setOpen(false);
              } finally {
                setSaving(false);
              }
            }}
            disabled={saving}
            style={({ pressed }) => [s.smallBtn, s.mlAuto, pressed && s.pressed60]}
          >
            <Text style={s.clearText}>Clear</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

export default function DiagnosticsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { theme } = useUnistyles();
  const devices = useDevices();
  const hostId = devices[0]?.id;
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [config, setConfig] = useState<PounceConfig | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    if (!hostId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    Promise.all([fetchDoctor(hostId), fetchHostConfig(hostId)])
      .then(([r, c]) => {
        setReport(r);
        setConfig(c);
      })
      .finally(() => setLoading(false));
  }, [hostId]);
  useEffect(() => load(), [load]);

  const savePath = useCallback(
    async (bin: string, value: string) => {
      if (!hostId) return;
      await saveHostConfig(hostId, { bins: { [bin]: value } });
      // Re-detect with the new path so the row flips to ✓ (or shows the fix).
      const [r, c] = await Promise.all([fetchDoctor(hostId), fetchHostConfig(hostId)]);
      setReport(r);
      setConfig(c);
    },
    [hostId],
  );

  const overrideFor = (bin?: string | null): string | null => {
    if (!bin) return null;
    return config?.bins?.[bin] ?? null;
  };

  return (
    <View style={[s.root, { paddingTop: insets.top + 8 }]}>
      <View style={s.headerRow}>
        <Text style={s.headerTitle}>Diagnostics</Text>
        <View style={s.headerActions}>
          <Pressable onPress={load} style={({ pressed }) => pressed && s.pressed60}>
            <PounceIcon name="refresh" size={18} color={theme.colors.fgMuted} />
          </Pressable>
          <Pressable onPress={() => router.back()} style={({ pressed }) => pressed && s.pressed60}>
            <Text style={s.doneLabel}>Done</Text>
          </Pressable>
        </View>
      </View>

      {loading ? (
        <View style={s.center}>
          <ActivityIndicator color={theme.colors.accent} />
        </View>
      ) : !report ? (
        <View style={s.empty}>
          <PounceIcon name="medkit-outline" size={34} color={theme.colors.fgFaint} />
          <Text style={s.emptyTitle}>Can't reach this machine's engine</Text>
          <Text style={s.emptyBody}>
            Pounce runs a small local service (needs Node.js). If it isn't starting, install Node.js and relaunch
            Pounce, then try again.
          </Text>
        </View>
      ) : (
        <ScrollView style={s.flex1} contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
          <Text style={s.summary}>
            {(report.sessionsTotal ?? 0) > 0
              ? `Found ${report.sessionsTotal} session${report.sessionsTotal === 1 ? "" : "s"} on ${report.host ?? "this Mac"}.`
              : `No agent sessions found on ${report.host ?? "this Mac"} yet — install an agent CLI below, then start a task.`}
          </Text>

          <Row ok={!!report.node?.ok} title="Node.js" detail={report.node?.version} />

          {report.network ? (
            <Row
              ok={!!report.network.reachable}
              warn={(report.network.ips?.length ?? 0) > 1}
              alwaysHint
              title="Phone pairing (same Wi-Fi)"
              detail={report.network.advertised ? `${report.network.advertised}:${report.network.port}` : "no LAN address"}
              hint={
                !report.network.reachable
                  ? "No local network address found — connect this Mac to Wi-Fi/Ethernet."
                  : (report.network.ips?.length ?? 0) > 1
                    ? `Multiple network addresses (${(report.network.ips ?? []).join(", ")}). Pounce advertises the first; if your phone can't connect on the same Wi-Fi, that address may be a VPN/Docker one it can't reach — and check System Settings → Network → Firewall allows incoming connections for Pounce.`
                    : "If your phone still can't connect on the same Wi-Fi, allow incoming connections for Pounce in System Settings → Network → Firewall."
              }
            />
          ) : null}

          {(report.agents ?? []).map((a) => {
            const override = a.override ?? overrideFor(a.bin);
            // An agent with transcripts on disk but no runnable CLI is "history
            // only": its past sessions still sync and show up in filters (you can
            // browse them), but new turns need the CLI. Surface that as a soft
            // warning instead of a hard "not installed" — otherwise it reads as a
            // contradiction with the agent appearing in the filter list.
            const historyOnly = !a.installed && a.sessionCount > 0;
            // Installed but its CLI isn't signed in (Cursor needs `cursor-agent
            // login` / CURSOR_API_KEY) — turns won't run, so flag it like gh.
            const needsAuth = !!a.auth?.required && a.auth.authenticated === false;
            return (
              <Row
                key={a.id}
                ok={a.installed && !needsAuth}
                title={a.name}
                detail={
                  !a.installed
                    ? historyOnly
                      ? `${a.sessionCount} sessions · history only`
                      : undefined
                    : needsAuth
                      ? "not signed in"
                      : a.sessionCount
                        ? `${a.sessionCount} sessions`
                        : "no sessions"
                }
                warn={needsAuth || historyOnly || (a.installed && a.sessionCount === 0)}
                hint={
                  historyOnly
                    ? `${a.name}'s past sessions are here (and appear in filters), but its CLI wasn't found on PATH — so you can browse them, not start new turns. Install the CLI, or set its path below if it's installed somewhere custom.`
                    : !a.installed
                      ? `${a.name} isn't installed (or wasn't found on PATH). Install its CLI — or if it's installed somewhere custom, set its path below.`
                      : needsAuth
                        ? `${a.name} is installed but not signed in — run \`${a.bin ?? a.id} login\` on this machine (or set CURSOR_API_KEY). New turns won't run until you sign in.`
                        : a.sessionCount === 0
                          ? `Installed, but no conversations yet — start a task in Pounce or run it once in a terminal.`
                          : override
                            ? `Using your custom path.`
                            : undefined
                }
                alwaysHint={!!override}
              >
                {a.bin ? (
                  <PathEditor bin={a.bin} detectedPath={a.path} override={override} onSaved={savePath} />
                ) : null}
              </Row>
            );
          })}

          {report.tunnel ? (
            <Row
              ok={!!report.tunnel.ok}
              warn={!report.tunnel.ok}
              title="Remote access"
              detail={report.tunnel.mode === "internet" ? "internet" : "LAN only"}
              hint="The off-LAN tunnel isn't installed, so your phone can reach this Mac only on the same Wi-Fi. On the same network it works now."
            />
          ) : null}

          <Row ok={!!report.git?.ok} title="git" detail={report.git?.version?.replace(/^git version /, "")} hint="git isn't found — some repo features (diffs, commits) won't work." />

          {report.gh ? (
          <Row
            ok={report.gh.ok && report.gh.authed !== false}
            warn={report.gh.ok && report.gh.authed === false}
            title="GitHub CLI (gh)"
            detail={
              !report.gh.ok
                ? undefined
                : report.gh.authed === false
                  ? `${report.gh.version ?? ""} · not signed in`.trim()
                  : report.gh.version ?? undefined
            }
            hint={
              !report.gh.ok
                ? "gh isn't installed — creating PRs and CI check status won't work. brew install gh"
                : "gh isn't signed in — run `gh auth login` on this machine to enable PRs and checks."
            }
          />
          ) : null}

          {report.configFile ? (
            <Text style={s.configNote}>
              Custom paths are saved to {report.configFile}.
            </Text>
          ) : null}
        </ScrollView>
      )}
    </View>
  );
}

const s = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.bg },
  flex1: { flex: 1 },
  pressed60: { opacity: 0.6 },
  pressed80: { opacity: 0.8 },
  row: {
    flexDirection: "row",
    gap: 10,
    borderBottomWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  rowHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  rowTitle: { fontSize: 14, fontWeight: "500", color: theme.colors.fg },
  rowDetail: { marginLeft: 8, fontFamily: "JetBrainsMono", fontSize: 11, color: theme.colors.fgMuted },
  rowHint: { marginTop: 4, fontSize: 12, lineHeight: 17, color: theme.colors.fgMuted },
  editLink: { marginTop: 6, flexDirection: "row", alignItems: "center", gap: 4 },
  editLinkText: { fontSize: 12, fontWeight: "500", color: theme.colors.accent },
  editor: { marginTop: 8, gap: 8 },
  editorHint: { fontSize: 11, lineHeight: 16, color: theme.colors.fgMuted },
  editorBin: { fontFamily: "JetBrainsMono", color: theme.colors.fg },
  editorInput: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.bgElevated,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontFamily: "JetBrainsMono",
    fontSize: 12,
    color: theme.colors.fg,
  },
  editorActions: { flexDirection: "row", alignItems: "center", gap: 8 },
  saveBtn: {
    borderRadius: 8,
    backgroundColor: theme.colors.accent,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  saveText: { fontSize: 12, fontWeight: "600", color: theme.colors.onAccent },
  smallBtn: { paddingHorizontal: 8, paddingVertical: 6 },
  cancelText: { fontSize: 12, color: theme.colors.fgMuted },
  mlAuto: { marginLeft: "auto" },
  clearText: { fontSize: 12, color: theme.colors.danger },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  headerTitle: { fontSize: 22, fontWeight: "700", color: theme.colors.fg },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 12 },
  doneLabel: { fontSize: 15, color: theme.colors.fgMuted },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 32 },
  emptyTitle: { marginTop: 12, textAlign: "center", fontSize: 15, fontWeight: "600", color: theme.colors.fg },
  emptyBody: { marginTop: 4, textAlign: "center", fontSize: 13, lineHeight: 19, color: theme.colors.fgMuted },
  summary: {
    paddingHorizontal: 16,
    paddingBottom: 8,
    paddingTop: 4,
    fontSize: 13,
    lineHeight: 19,
    color: theme.colors.fgMuted,
  },
  configNote: {
    paddingHorizontal: 16,
    paddingTop: 12,
    fontSize: 11,
    lineHeight: 16,
    color: theme.colors.fgFaint,
  },
}));
