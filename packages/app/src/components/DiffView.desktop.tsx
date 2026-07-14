import { memo, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { LegendList } from "@legendapp/list/react-native";
import { Ionicons } from "@expo/vector-icons";
import {
  classifyLine,
  DIFF_META_RE,
  extOf,
  LINE_CLASS,
  splitPatch,
  type LineKind,
  type PatchFile,
} from "./diffPatch";
import { cn, COLOR } from "../ui";
import type { DiffViewProps } from "./DiffViewTypes";

/** Flattened rows the list renders: a file separator, a unified line, or a
 *  split (side-by-side) pair. */
type Row =
  | { type: "file"; path: string; adds: number; dels: number }
  | { type: "line"; kind: LineKind; text: string }
  | { type: "pair"; left: { kind: LineKind; text: string } | null; right: { kind: LineKind; text: string } | null };

/** Body lines of one file's patch, with git metadata headers dropped. */
function bodyLines(text: string): string[] {
  return text.split("\n").filter((l) => !DIFF_META_RE.test(l));
}

/** Pair del/add runs into side-by-side rows for the split layout. */
function toPairs(lines: string[]): Row[] {
  const rows: Row[] = [];
  let i = 0;
  while (i < lines.length) {
    const kind = classifyLine(lines[i]);
    if (kind === "del") {
      // Collect the deletion run, then the addition run that follows it.
      const dels: string[] = [];
      while (i < lines.length && classifyLine(lines[i]) === "del") dels.push(lines[i++]);
      const adds: string[] = [];
      while (i < lines.length && classifyLine(lines[i]) === "add") adds.push(lines[i++]);
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
 * (file sections, unified/split layouts, extension filter, Viewed accordions):
 * react-native-webview has no solid macOS/Windows build, so the @pierre/diffs
 * DOM component mobile uses can't run here.
 */
export const DiffView = memo(function DiffView({
  patch,
  layout = "unified",
  extFilter,
  seenPaths = [],
  onToggleSeen,
}: DiffViewProps) {
  // "Viewed" state lives in the persisted store the parent syncs via
  // seenPaths/onToggleSeen; only the accordion collapse is local. Seen files
  // start collapsed.
  const viewed = useMemo(() => new Set(seenPaths), [seenPaths]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(seenPaths));
  const toggleCollapsed = (path: string, force?: boolean) =>
    setCollapsed((cur) => {
      const next = new Set(cur);
      const on = force ?? !next.has(path);
      if (on) next.add(path);
      else next.delete(path);
      return next;
    });
  const toggleViewed = (path: string) => {
    const nowViewed = !viewed.has(path);
    toggleCollapsed(path, nowViewed); // viewed collapses, unviewed expands
    void onToggleSeen?.(path, nowViewed);
  };

  // Two-level memo: the parse and per-file row building depend only on the
  // patch/layout, so a collapse toggle just re-concatenates arrays instead of
  // re-running splitPatch + regexes over the whole diff.
  const files = useMemo(() => splitPatch(patch), [patch]);
  const fileRows = useMemo(
    () =>
      files.map((f: PatchFile) => ({
        file: f,
        rows:
          layout === "split"
            ? toPairs(bodyLines(f.text))
            : bodyLines(f.text).map<Row>((l) => ({ type: "line", kind: classifyLine(l), text: l })),
      })),
    [files, layout],
  );
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const { file, rows: body } of fileRows) {
      if (extFilter && extOf(file.path) !== extFilter) continue;
      out.push({ type: "file", path: file.path, adds: file.adds, dels: file.dels });
      if (!collapsed.has(file.path)) out.push(...body);
    }
    return out;
  }, [fileRows, extFilter, collapsed]);

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
              onPress={() => toggleCollapsed(item.path)}
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
});
