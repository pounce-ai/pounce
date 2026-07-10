import { useMemo } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useSelector } from "@legendapp/state/react";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { syncLog$, type SyncLogEntry } from "../state/stores";
import { COLOR, timeAgo } from "../ui";

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
  const router = useRouter();
  const log = useSelector(() => syncLog$.get());
  const sections = useMemo(() => groupByDay(log), [log]);

  return (
    <View className="flex-1 bg-bg" style={{ paddingTop: insets.top + 8 }}>
      <View className="flex-row items-center justify-between px-4 pb-3">
        <Text className="text-[22px] font-bold text-fg">Sync history</Text>
        <Pressable onPress={() => router.back()} className="active:opacity-60">
          <Text className="text-[15px] text-fg-muted">Done</Text>
        </Pressable>
      </View>

      {log.length === 0 ? (
        <View className="flex-1 items-center justify-center px-8">
          <Text className="text-[40px]">🕓</Text>
          <Text className="mt-3 text-center text-[15px] font-semibold text-fg">Nothing synced yet</Text>
          <Text className="mt-1 text-center text-[13px] text-fg-muted">
            Each time new agent activity reaches this device, it'll show up here — grouped by folder.
          </Text>
        </View>
      ) : (
        <ScrollView
          className="flex-1 px-4"
          contentContainerStyle={{ paddingTop: 4, paddingBottom: insets.bottom + 24, gap: 18 }}
        >
          {sections.map((section) => (
            <View key={section.label} className="gap-2">
              <Text className="text-[12px] uppercase tracking-wide text-fg-faint">{section.label}</Text>
              {section.entries.map((entry) => {
                const total = entry.repos.reduce((n, r) => n + r.count, 0);
                return (
                  <View
                    key={entry.at}
                    className="gap-2.5 rounded-2xl border border-border bg-surface px-4 py-3.5"
                  >
                    <View className="flex-row items-center gap-2">
                      <Ionicons name="sync" size={14} color={COLOR.accent} />
                      <Text className="flex-1 text-[14px] font-semibold text-fg">
                        {clock(new Date(entry.at))}
                      </Text>
                      <Text className="text-[12px] text-fg-faint">{timeAgo(entry.at)} ago</Text>
                    </View>
                    <Text className="text-[12px] text-fg-muted">
                      {total} new update{total === 1 ? "" : "s"} across {entry.repos.length} folder
                      {entry.repos.length === 1 ? "" : "s"}
                    </Text>
                    <View className="gap-1.5">
                      {entry.repos.map((r) => (
                        <View key={r.repoId} className="flex-row items-center gap-2">
                          <Ionicons name="folder-outline" size={13} color={COLOR.fgFaint} />
                          <Text numberOfLines={1} className="flex-1 text-[13px] text-fg">
                            {r.name}
                          </Text>
                          <Text className="text-[12px] font-medium text-fg-muted">{r.count}</Text>
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
