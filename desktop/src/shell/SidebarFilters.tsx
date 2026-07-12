/**
 * Desktop sidebar filters — the narrowing controls (Agent · Device · Project)
 * that mobile has in its bottom-sheet FilterSheet, rendered instead as a compact
 * inline panel that fits the dense sidebar. Writes straight to the shared
 * `filters$`, so it stays in lockstep with mobile. Sections only appear when
 * there's a real choice (>1 agent / device / project). Deliberately omits
 * "Needs you" — the sidebar's job is to show everything (attention floats to the
 * top via ranking), so a filter that hides most threads doesn't belong here.
 */
import { type ReactNode, useMemo } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useSelector } from "@legendapp/state/react";
import { Ionicons } from "@expo/vector-icons";
import {
  activeFilterCount,
  agentsInScope,
  CLEARED_FILTERS,
  deviceEmoji,
  deviceLabel,
  filters$,
  hasActiveFilter,
  reposByActivity,
} from "@litter/app/state/stores";
import { useDevices, useProjects, useThreads } from "@litter/app/state/db/hooks";
import { agentLabel, AgentLogo, cn, COLOR, DeviceIcon } from "@litter/app/ui";

/** Filter trigger for the sidebar top bar (icon + active-count badge). */
export function SidebarFilterButton({ active, onPress }: { active: boolean; onPress: () => void }) {
  const count = useSelector(() => activeFilterCount());
  const on = active || count > 0;
  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel="Filter threads"
      className={cn(
        "active:opacity-80 h-8 w-8 items-center justify-center rounded-lg border",
        on ? "border-accent bg-accent/15" : "border-border bg-surface",
      )}
    >
      <Ionicons name="filter" size={15} color={on ? COLOR.accent : COLOR.fgMuted} />
      {count > 0 ? (
        <View className="absolute -right-1 -top-1 h-3.5 min-w-3.5 items-center justify-center rounded-full bg-accent px-1">
          <Text className="text-[9px] font-bold text-white">{count}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

function Chip({
  label,
  active,
  onPress,
  icon,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  icon?: ReactNode;
}) {
  return (
    <Pressable
      onPress={onPress}
      className={cn(
        "active:opacity-80 h-7 flex-row items-center gap-1 rounded-full border px-2.5",
        active ? "border-accent bg-accent/15" : "border-border bg-surface",
      )}
    >
      {icon}
      <Text numberOfLines={1} className={cn("max-w-[130px] text-[12px]", active ? "text-accent" : "text-fg")}>
        {label}
      </Text>
    </Pressable>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View className="gap-1.5">
      <Text className="text-[10px] font-semibold uppercase tracking-wide text-fg-faint">{title}</Text>
      <View className="flex-row flex-wrap gap-1.5">{children}</View>
    </View>
  );
}

/** Inline filter panel shown below the sidebar's search when the button is on. */
export function SidebarFilterPanel() {
  const f = useSelector(() => filters$.get());
  const devices = useDevices();
  const threads = useThreads();
  const projects = useProjects();
  const agents = useMemo(() => agentsInScope(threads), [threads]);
  const repos = useMemo(
    () => reposByActivity(projects, threads, { device: f.device, agent: f.agent }),
    [projects, threads, f.device, f.agent],
  );

  const anyChoice = agents.length > 1 || devices.length > 1 || repos.length > 1;
  const active = hasActiveFilter();

  return (
    <View className="mx-3 mb-1 gap-3 rounded-xl border border-border bg-bg px-3 py-3">
      <View className="flex-row items-center justify-between">
        <Text className="text-[12px] font-bold text-fg">Filter</Text>
        {active ? (
          <Pressable
            onPress={() => filters$.set(CLEARED_FILTERS)}
            className="active:opacity-60 flex-row items-center gap-1"
          >
            <Ionicons name="close-circle-outline" size={13} color={COLOR.fgMuted} />
            <Text className="text-[11px] text-fg-muted">Clear</Text>
          </Pressable>
        ) : null}
      </View>

      {agents.length > 1 ? (
        <Section title="Agent">
          {agents.map((a) => (
            <Chip
              key={a}
              label={agentLabel(a)}
              active={f.agent === a}
              onPress={() => filters$.agent.set(f.agent === a ? null : a)}
              icon={<AgentLogo agent={a} size={12} />}
            />
          ))}
        </Section>
      ) : null}

      {devices.length > 1 ? (
        <Section title="Device">
          {devices.map((d) => (
            <Chip
              key={d.id}
              label={deviceLabel(d.id, d.name)}
              active={f.device === d.id}
              onPress={() => filters$.device.set(f.device === d.id ? null : d.id)}
              icon={
                <DeviceIcon
                  name={d.name}
                  emoji={deviceEmoji(d.id)}
                  color={f.device === d.id ? COLOR.accent : COLOR.fgMuted}
                  size={12}
                />
              }
            />
          ))}
        </Section>
      ) : null}

      {repos.length > 1 ? (
        <View className="gap-1.5">
          <View className="flex-row items-center justify-between">
            <Text className="text-[10px] font-semibold uppercase tracking-wide text-fg-faint">Project</Text>
            {f.repos.length ? (
              <Pressable onPress={() => filters$.repos.set([])} className="active:opacity-60">
                <Text className="text-[11px] text-fg-muted">Clear ({f.repos.length})</Text>
              </Pressable>
            ) : null}
          </View>
          <ScrollView style={{ maxHeight: 160 }} nestedScrollEnabled className="flex-row">
            <View className="flex-1 flex-row flex-wrap gap-1.5">
              {repos.map((r) => (
                <Chip
                  key={r.id}
                  label={r.name}
                  active={f.repos.includes(r.id)}
                  onPress={() =>
                    filters$.repos.set(
                      f.repos.includes(r.id) ? f.repos.filter((id) => id !== r.id) : [...f.repos, r.id],
                    )
                  }
                  icon={
                    <Ionicons
                      name="folder-outline"
                      size={11}
                      color={f.repos.includes(r.id) ? COLOR.accent : COLOR.fgFaint}
                    />
                  }
                />
              ))}
            </View>
          </ScrollView>
        </View>
      ) : null}

      {!anyChoice ? (
        <Text className="text-[11px] leading-[16px] text-fg-muted">
          Nothing to filter yet — once you have threads across more than one agent, device, or project, the
          controls appear here.
        </Text>
      ) : null}
    </View>
  );
}
