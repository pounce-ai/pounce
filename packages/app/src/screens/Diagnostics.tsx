/**
 * Pounce Doctor — shows the host's runtime health so a fresh or custom setup
 * can see exactly what's missing (node, the agent CLIs, git, off-LAN tunnel,
 * whether there are any sessions yet) instead of a blank app.
 */
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import type { DoctorReport } from "@litter/shared";
import { fetchDoctor } from "../services/bridge";
import { useDevices } from "../state/db/hooks";
import { COLOR } from "../ui";

function Row({
  ok,
  title,
  detail,
  hint,
  warn,
}: {
  ok: boolean;
  title: string;
  detail?: string | null;
  /** Shown when not ok (or when `warn`) — how to fix it. */
  hint?: string;
  /** A soft warning (works, but limited) rather than a hard failure. */
  warn?: boolean;
}) {
  const color = ok ? COLOR.success : warn ? "#d29922" : COLOR.danger;
  const icon = ok ? "checkmark-circle" : warn ? "alert-circle" : "close-circle";
  return (
    <View className="flex-row gap-2.5 border-b border-border px-4 py-3">
      <Ionicons name={icon} size={18} color={color} style={{ marginTop: 1 }} />
      <View className="flex-1">
        <View className="flex-row items-center justify-between">
          <Text className="text-[14px] font-medium text-fg">{title}</Text>
          {detail ? <Text className="ml-2 font-mono text-[11px] text-fg-muted">{detail}</Text> : null}
        </View>
        {!ok || warn ? (hint ? <Text className="mt-1 text-[12px] leading-[17px] text-fg-muted">{hint}</Text> : null) : null}
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
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    if (!hostId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    fetchDoctor(hostId)
      .then(setReport)
      .finally(() => setLoading(false));
  }, [hostId]);
  useEffect(() => load(), [load]);

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
            {report.sessionsTotal > 0
              ? `Found ${report.sessionsTotal} session${report.sessionsTotal === 1 ? "" : "s"} on ${report.host}.`
              : `No agent sessions found on ${report.host} yet — install an agent CLI below, then start a task.`}
          </Text>

          <Row ok={report.node.ok} title="Node.js" detail={report.node.version} />

          {report.agents.map((a) => (
            <Row
              key={a.id}
              ok={a.installed}
              title={a.name}
              detail={a.installed ? (a.sessionCount ? `${a.sessionCount} sessions` : "no sessions") : undefined}
              warn={a.installed && a.sessionCount === 0}
              hint={
                !a.installed
                  ? `${a.name} isn't installed (or wasn't found on PATH). Install its CLI, then reopen Pounce.`
                  : a.sessionCount === 0
                    ? `Installed, but no conversations yet — start a task in Pounce or run it once in a terminal.`
                    : undefined
              }
            />
          ))}

          <Row
            ok={report.tunnel.ok}
            warn={!report.tunnel.ok}
            title="Remote access"
            detail={report.tunnel.mode === "internet" ? "internet" : "LAN only"}
            hint="The off-LAN tunnel isn't installed, so your phone can reach this Mac only on the same Wi-Fi. On the same network it works now."
          />

          <Row ok={report.git.ok} title="git" detail={report.git.version?.replace(/^git version /, "")} hint="git isn't found — some repo features (diffs, commits) won't work." />
        </ScrollView>
      )}
    </View>
  );
}
