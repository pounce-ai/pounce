import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { LegendList } from "@legendapp/list/react-native";
import { Ionicons } from "@expo/vector-icons";
import { extOf, splitPatch } from "./diffPatch";
import { cn, COLOR } from "../ui";
import type { DiffViewProps } from "./DiffViewTypes";

type Kind = "hunk" | "add" | "del" | "ctx";

function classify(line: string): Kind {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "ctx";
}

const LINE_CLASS: Record<Kind, string> = {
  hunk: "text-info",
  add: "bg-diff-add-bg text-diff-add-fg",
  del: "bg-diff-del-bg text-diff-del-fg",
  ctx: "text-fg-muted",
};

/** Flattened rows the list renders: a file separator, a unified line, or a
 *  split (side-by-side) pair. */
type Row =
  | { type: "file"; path: string; adds: number; dels: number }
  | { type: "line"; kind: Kind; text: string }
  | { type: "pair"; left: { kind: Kind; text: string } | null; right: { kind: Kind; text: string } | null };

/** Body lines of one file's patch, with git metadata headers dropped. */
function bodyLines(text: string): string[] {
  return text
    .split("\n")
    .filter((l) => !/^(diff --git|index |--- |\+\+\+ |new file|deleted file|rename |similarity |old mode|new mode|Binary files)/.test(l));
}

/** Pair del/add runs into side-by-side rows for the split layout. */
function toPairs(lines: string[]): Row[] {
  const rows: Row[] = [];
  let i = 0;
  while (i < lines.length) {
    const kind = classify(lines[i]);
    if (kind === "del") {
      // Collect the deletion run, then the addition run that follows it.
      const dels: string[] = [];
      while (i < lines.length && classify(lines[i]) === "del") dels.push(lines[i++]);
      const adds: string[] = [];
      while (i < lines.length && classify(lines[i]) === "add") adds.push(lines[i++]);
      for (let n = 0; n < Math.max(dels.length, adds.length); n++) {
        rows.push({
          type: "pair",
          left: n < dels.length ? { kind: "del", text: dels[n] } : null,
          right: n < adds.length ? { kind: "add", text: adds[n] } : null,
        });
      }
      continue;
    }
    if (kind === "add") {
      rows.push({ type: "pair", left: null, right: { kind: "add", text: lines[i++] } });
      continue;
    }
    if (kind === "hunk") {
      rows.push({ type: "line", kind: "hunk", text: lines[i++] });
      continue;
    }
    const l = { kind: "ctx" as const, text: lines[i++] };
    rows.push({ type: "pair", left: l, right: l });
  }
  return rows;
}

/** Strip the leading +/-/space diff marker for split cells (columns carry the color). */
function cellText(text: string): string {
  return /^[+\- ]/.test(text) ? text.slice(1) : text;
}

/**
 * Unified-diff viewer — desktop implementation. A native structured renderer
 * (file sections, unified/split layouts, file filter): react-native-webview
 * has no solid macOS/Windows build, so the @pierre/diffs DOM component mobile
 * uses can't run here.
 */
export function DiffView({ patch, layout = "unified", extFilter, seenPaths, onToggleSeen }: DiffViewProps) {
  // File headers act as accordions — tapping one collapses that file's hunks.
  // "Viewed" (GitHub PR style) marks review progress, collapses the file, and
  // persists — already-seen files come back collapsed.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(seenPaths));
  const [viewed, setViewed] = useState<Set<string>>(() => new Set(seenPaths));
  const toggleIn = (set: React.Dispatch<React.SetStateAction<Set<string>>>, path: string, force?: boolean) =>
    set((cur) => {
      const next = new Set(cur);
      const on = force ?? !next.has(path);
      if (on) next.add(path);
      else next.delete(path);
      return next;
    });
  const toggleViewed = (path: string) => {
    const nowViewed = !viewed.has(path);
    toggleIn(setViewed, path);
    toggleIn(setCollapsed, path, nowViewed); // viewed collapses, unviewed expands
    void onToggleSeen?.(path, nowViewed);
  };

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const f of splitPatch(patch)) {
      if (extFilter && extOf(f.path) !== extFilter) continue;
      out.push({ type: "file", path: f.path, adds: f.adds, dels: f.dels });
      if (collapsed.has(f.path)) continue;
      const lines = bodyLines(f.text);
      if (layout === "split") {
        out.push(...toPairs(lines));
      } else {
        for (const l of lines) out.push({ type: "line", kind: classify(l), text: l });
      }
    }
    return out;
  }, [patch, layout, extFilter, collapsed]);

  return (
    <LegendList
      data={rows}
      keyExtractor={(_, i) => String(i)}
      estimatedItemSize={18}
      renderItem={({ item }) => {
        if (item.type === "file") {
          const isCollapsed = collapsed.has(item.path);
          const isViewed = viewed.has(item.path);
          return (
            <Pressable
              onPress={() => toggleIn(setCollapsed, item.path)}
              className="active:bg-surface-hover mb-1 mt-3 flex-row items-center gap-2 border-b border-border bg-bg-elevated px-3 py-2"
            >
              <Ionicons
                name={isCollapsed ? "chevron-forward" : "chevron-down"}
                size={13}
                color={COLOR.fgFaint}
              />
              <Ionicons name="document-text-outline" size={13} color={COLOR.fgMuted} />
              <Text
                numberOfLines={1}
                className={cn("flex-1 font-mono text-[12px] font-semibold", isViewed ? "text-fg-faint" : "text-fg")}
              >
                {item.path}
              </Text>
              <Text className="text-[12px] font-semibold">
                <Text className="text-diff-add-fg">+{item.adds}</Text>{" "}
                <Text className="text-diff-del-fg">-{item.dels}</Text>
              </Text>
              <Pressable
                onPress={() => toggleViewed(item.path)}
                hitSlop={6}
                className="active:opacity-70 flex-row items-center gap-1.5"
              >
                <Ionicons
                  name={isViewed ? "checkbox" : "square-outline"}
                  size={15}
                  color={isViewed ? COLOR.accent : COLOR.fgFaint}
                />
                <Text className="text-[12px] text-fg-muted">Viewed</Text>
              </Pressable>
            </Pressable>
          );
        }
        if (item.type === "pair") {
          return (
            <View className="flex-row px-3">
              <Text
                numberOfLines={1}
                className={cn(
                  "flex-1 border-r border-border/40 pr-2 font-mono text-[11px] leading-[18px]",
                  item.left ? LINE_CLASS[item.left.kind] : "",
                )}
              >
                {item.left ? cellText(item.left.text) || " " : " "}
              </Text>
              <Text
                numberOfLines={1}
                className={cn(
                  "flex-1 pl-2 font-mono text-[11px] leading-[18px]",
                  item.right ? LINE_CLASS[item.right.kind] : "",
                )}
              >
                {item.right ? cellText(item.right.text) || " " : " "}
              </Text>
            </View>
          );
        }
        return (
          <Text className={cn("px-3 font-mono text-[11px] leading-[18px]", LINE_CLASS[item.kind])}>
            {item.text || " "}
          </Text>
        );
      }}
      contentContainerStyle={{ paddingBottom: 6 }}
    />
  );
}
