import { useMemo } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PounceIcon } from "../ui/native/Icon";
import type { SyncLogEntry } from "../state/stores";
import { useDevices, useSyncLog } from "../state/db/hooks";
import { timeAgo } from "../ui";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "3:42 PM" — locale-independent so it renders the same on any Hermes build. */
function clock(d: Date): string {
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h < 12 ? "AM" : "PM";
  h = h % 12 || 12;
  return `${h}:${m < 10 ? "0" : ""}${m} ${ampm}`;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function dayLabel(d: Date): string {
  const now = new Date();
  if (sameDay(d, now)) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, yesterday)) return "Yesterday";
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

interface DaySection {
  label: string;
  entries: SyncLogEntry[];
}

/** Bucket the reverse-chronological log into day sections, preserving order. */
function groupByDay(log: SyncLogEntry[]): DaySection[] {
  const sections: DaySection[] = [];
  let current: DaySection | null = null;
  for (const entry of log) {
    const label = dayLabel(new Date(entry.at));
    if (!current || current.label !== label) {
      current = { label, entries: [] };
      sections.push(current);
    }
    current.entries.push(entry);
  }
  return sections;
}

export default function SyncHistoryScreen() {
  const insets = useSafeAreaInsets();
  const { theme } = useUnistyles();
  const rows = useSyncLog();
  const devices = useDevices();
  // The collection isn't intrinsically ordered — present newest-first.
  const log = useMemo(() => [...rows].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)), [rows]);
  const sections = useMemo(() => groupByDay(log), [log]);

  return (
    <View style={[s.root, { paddingTop: 8 }]}>
      {log.length === 0 ? (
        <View style={s.empty}>
          <Text style={s.emptyEmoji}>🕓</Text>
          <Text style={s.emptyTitle}>Nothing synced yet</Text>
          <Text style={s.emptyBody}>
            {devices.length
              ? "Each time new agent activity reaches this device, it'll show up here — grouped by folder."
              : "Connect a computer and its agent activity shows up here."}
          </Text>
        </View>
      ) : (
        <ScrollView
          style={s.scroll}
          contentContainerStyle={{ paddingTop: 4, paddingBottom: insets.bottom + 24, gap: 18 }}
        >
          {sections.map((section) => (
            <View key={section.label} style={s.section}>
              <Text style={s.sectionLabel}>{section.label}</Text>
              {section.entries.map((entry) => {
                const total = entry.repos.reduce((n, r) => n + r.count, 0);
                return (
                  <View key={entry.at} style={s.card}>
                    <View style={s.cardHeader}>
                      <PounceIcon name="sync" size={14} color={theme.colors.accent} />
                      <Text style={s.cardTime}>{clock(new Date(entry.at))}</Text>
                      <Text style={s.cardAgo}>{timeAgo(entry.at)} ago</Text>
                    </View>
                    <Text style={s.cardSummary}>
                      {total} new update{total === 1 ? "" : "s"} across {entry.repos.length} space
                      {entry.repos.length === 1 ? "" : "s"}
                    </Text>
                    <View style={s.repoList}>
                      {entry.repos.map((r) => (
                        <View key={r.repoId} style={s.repoRow}>
                          <PounceIcon
                            name="folder-outline"
                            size={13}
                            color={theme.colors.fgFaint}
                          />
                          <Text numberOfLines={1} style={s.repoName}>
                            {r.name}
                          </Text>
                          <Text style={s.repoCount}>{r.count}</Text>
                        </View>
                      ))}
                    </View>
                  </View>
                );
              })}
            </View>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const s = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.bg },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  headerTitle: { fontSize: 22, fontWeight: "700", color: theme.colors.fg },
  doneLabel: { fontSize: 15, color: theme.colors.fgMuted },
  pressed60: { opacity: 0.6 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 32 },
  emptyEmoji: { fontSize: 40 },
  emptyTitle: {
    marginTop: 12,
    textAlign: "center",
    fontSize: 15,
    fontWeight: "600",
    color: theme.colors.fg,
  },
  emptyBody: { marginTop: 4, textAlign: "center", fontSize: 13, color: theme.colors.fgMuted },
  scroll: { flex: 1, paddingHorizontal: 16 },
  section: { gap: 8 },
  sectionLabel: {
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    color: theme.colors.fgFaint,
  },
  card: {
    gap: 10,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  cardHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  cardTime: { flex: 1, fontSize: 14, fontWeight: "600", color: theme.colors.fg },
  cardAgo: { fontSize: 12, color: theme.colors.fgFaint },
  cardSummary: { fontSize: 12, color: theme.colors.fgMuted },
  repoList: { gap: 6 },
  repoRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  repoName: { flex: 1, fontSize: 13, color: theme.colors.fg },
  repoCount: { fontSize: 12, fontWeight: "500", color: theme.colors.fgMuted },
}));
