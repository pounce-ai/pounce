/**
 * Pounce Doctor — shows the host's runtime health so a fresh or custom setup
 * can see exactly what's missing (node, the agent CLIs, git, off-LAN tunnel,
 * whether there are any sessions yet) instead of a blank app. For custom setups
 * where auto-detection fails (a shadowed/oddly-installed CLI) each agent has a
 * "Set path…" editor that pins an absolute binary path the host then honors.
 */
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import type { DoctorReport, PounceConfig } from "@litter/shared";
import { fetchDoctor, fetchHostConfig, saveHostConfig } from "../services/bridge";
import { useDevices } from "../state/db/hooks";
import { COLOR } from "../ui";

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
  const color = ok ? COLOR.success : warn ? "#d29922" : COLOR.danger;
  const icon = ok ? "checkmark-circle" : warn ? "alert-circle" : "close-circle";
  const showHint = !ok || warn || alwaysHint;
  return (
    <View className="flex-row gap-2.5 border-b border-border px-4 py-3">
      <Ionicons name={icon} size={18} color={color} style={{ marginTop: 1 }} />
      <View className="flex-1">
        <View className="flex-row items-center justify-between">
          <Text className="text-[14px] font-medium text-fg">{title}</Text>
          {detail ? <Text className="ml-2 font-mono text-[11px] text-fg-muted">{detail}</Text> : null}
        </View>
        {showHint && hint ? <Text className="mt-1 text-[12px] leading-[17px] text-fg-muted">{hint}</Text> : null}
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
        className="mt-1.5 flex-row items-center gap-1 active:opacity-60"
      >
        <Ionicons name="create-outline" size={13} color={COLOR.accent} />
        <Text className="text-[12px] font-medium text-accent">
          {override ? "Change path" : "Set path manually"}
        </Text>
      </Pressable>
    );
  }

  return (
    <View className="mt-2 gap-2">
      <Text className="text-[11px] leading-[16px] text-fg-muted">
        Absolute path to the <Text className="font-mono text-fg">{bin}</Text> binary
        {detectedPath ? ` (auto-detected: ${detectedPath})` : ""}.
      </Text>
      <TextInput
        value={draft}
        onChangeText={setDraft}
        placeholder={`/path/to/${bin}`}
        placeholderTextColor={COLOR.fgFaint}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        className="rounded-lg border border-border bg-bg-elevated px-3 py-2 font-mono text-[12px] text-fg"
      />
      <View className="flex-row items-center gap-2">
        <Pressable
          onPress={save}
          disabled={saving}
          className="rounded-lg bg-accent px-3 py-1.5 active:opacity-80"
          style={{ opacity: saving ? 0.6 : 1 }}
        >
          <Text className="text-[12px] font-semibold text-white">{saving ? "Saving…" : "Save"}</Text>
        </Pressable>
        <Pressable onPress={() => setOpen(false)} disabled={saving} className="px-2 py-1.5 active:opacity-60">
          <Text className="text-[12px] text-fg-muted">Cancel</Text>
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
            className="ml-auto px-2 py-1.5 active:opacity-60"
          >
            <Text className="text-[12px] text-danger">Clear</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

export default function DiagnosticsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
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
    <View className="flex-1 bg-bg" style={{ paddingTop: insets.top + 8 }}>
      <View className="flex-row items-center justify-between px-4 pb-3">
        <Text className="text-[22px] font-bold text-fg">Diagnostics</Text>
        <View className="flex-row items-center gap-3">
          <Pressable onPress={load} className="active:opacity-60">
            <Ionicons name="refresh" size={18} color={COLOR.fgMuted} />
          </Pressable>
          <Pressable onPress={() => router.back()} className="active:opacity-60">
            <Text className="text-[15px] text-fg-muted">Done</Text>
          </Pressable>
        </View>
      </View>

      {loading ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color={COLOR.accent} />
        </View>
      ) : !report ? (
        <View className="flex-1 items-center justify-center px-8">
          <Ionicons name="medkit-outline" size={34} color={COLOR.fgFaint} />
          <Text className="mt-3 text-center text-[15px] font-semibold text-fg">Can't reach this machine's engine</Text>
          <Text className="mt-1 text-center text-[13px] leading-[19px] text-fg-muted">
            Pounce runs a small local service (needs Node.js). If it isn't starting, install Node.js and relaunch
            Pounce, then try again.
          </Text>
        </View>
      ) : (
        <ScrollView className="flex-1" contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
          <Text className="px-4 pb-2 pt-1 text-[13px] leading-[19px] text-fg-muted">
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
            return (
              <Row
                key={a.id}
                ok={a.installed}
                title={a.name}
                detail={a.installed ? (a.sessionCount ? `${a.sessionCount} sessions` : "no sessions") : undefined}
                warn={a.installed && a.sessionCount === 0}
                hint={
                  !a.installed
                    ? `${a.name} isn't installed (or wasn't found on PATH). Install its CLI — or if it's installed somewhere custom, set its path below.`
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

          {report.configFile ? (
            <Text className="px-4 pt-3 text-[11px] leading-[16px] text-fg-faint">
              Custom paths are saved to {report.configFile}.
            </Text>
          ) : null}
        </ScrollView>
      )}
    </View>
  );
}
