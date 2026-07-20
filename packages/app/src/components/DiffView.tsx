import { memo, useEffect, useMemo, useState } from "react";
import { ScrollView, StyleSheet, Text, View, type TextStyle } from "react-native";
import PatchDiffDOM from "./PatchDiffDOM";
import { classifyLine, type LineKind } from "./diffPatch";
import type { DiffViewProps } from "./DiffViewTypes";
import { T } from "../ui/theme";

/** How long the DOM renderer gets to report ready before we fall back. */
const DOM_READY_TIMEOUT_MS = 6000;

/** Styles per diff-line kind (replaces the old shared Tailwind LINE_CLASS map). */
const LINE_STYLE: Record<LineKind, TextStyle> = {
  header: { color: T.fgFaint },
  hunk: { color: T.info },
  add: { backgroundColor: T.diffAddBg, color: T.diffAddFg },
  del: { backgroundColor: T.diffDelBg, color: T.diffDelFg },
  ctx: { color: T.fgMuted },
};

/**
 * Unified-diff viewer seam. Mobile: @pierre/diffs (syntax highlighting,
 * file headers, word-level change highlights) inside an Expo DOM component.
 * Desktop overrides this per-platform (DiffView.desktop.tsx) with a native
 * structured renderer — react-native-webview has no solid macOS build.
 *
 * The WebView boots blank before react-dom hydrates, so a skeleton covers it
 * until the DOM component reports ready; if that never happens (bundler issue,
 * webview failure), a plain native line renderer takes over.
 *
 * memo matters here: the parent re-renders per keystroke in the commit box,
 * and un-memoed props would re-marshal the whole patch into the WebView.
 */
export const DiffView = memo(function DiffView({
  patch,
  layout = "unified",
  extFilter,
  seenPaths,
  onToggleSeen,
}: DiffViewProps) {
  const [dom, setDom] = useState<"loading" | "ready" | "failed">("loading");

  useEffect(() => {
    if (dom !== "loading") return;
    const t = setTimeout(
      () => setDom((s) => (s === "loading" ? "failed" : s)),
      DOM_READY_TIMEOUT_MS,
    );
    return () => clearTimeout(t);
  }, [dom]);

  if (dom === "failed") return <FallbackDiff patch={patch} />;

  return (
    <View style={s.flex1}>
      <PatchDiffDOM
        patch={patch}
        diffStyle={layout}
        extFilter={extFilter}
        seenPaths={seenPaths}
        onToggleSeen={onToggleSeen}
        onReady={() => setDom("ready")}
        dom={{
          style: { flex: 1, backgroundColor: "#0b0b0f", opacity: dom === "ready" ? 1 : 0 },
          containerStyle: { flex: 1 },
        }}
      />
      {dom === "loading" ? <DiffSkeleton /> : null}
    </View>
  );
});

/** File-section shaped placeholder shown while the DOM renderer boots. */
function DiffSkeleton() {
  return (
    <View style={s.skeleton} pointerEvents="none">
      {[0, 1, 2].map((sec) => (
        <View key={sec}>
          <View style={s.skelHeader}>
            <View style={s.skelIcon} />
            <View style={[s.skelTitle, { maxWidth: 180 + sec * 40 }]} />
            <View style={s.skelStat} />
          </View>
          {[0, 1, 2, 3, 4].map((l) => (
            <View key={l} style={s.skelLineRow}>
              <View style={s.skelLineNo} />
              <View
                style={[s.skelLine, { width: `${30 + ((sec * 5 + l * 37) % 55)}%` }]}
              />
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

/** Plain colored-line renderer — the escape hatch when the DOM viewer dies. */
function FallbackDiff({ patch }: { patch: string }) {
  const lines = useMemo(() => patch.split("\n"), [patch]);
  return (
    <ScrollView style={s.flex1} contentContainerStyle={{ paddingVertical: 6 }}>
      {lines.map((line, i) => (
        <Text key={i} style={[s.diffLine, LINE_STYLE[classifyLine(line)]]}>
          {line || " "}
        </Text>
      ))}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  flex1: { flex: 1 },
  skeleton: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: T.bg,
    paddingHorizontal: 0,
    paddingTop: 4,
  },
  skelHeader: {
    marginTop: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderBottomWidth: 1,
    borderTopWidth: 1,
    borderColor: T.border,
    backgroundColor: T.bgElevated,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  skelIcon: { height: 16, width: 16, borderRadius: 4, backgroundColor: T.surfaceHover },
  skelTitle: { height: 12, flex: 1, borderRadius: 4, backgroundColor: T.surfaceHover },
  skelStat: { height: 12, width: 48, borderRadius: 4, backgroundColor: T.surfaceHover },
  skelLineRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  skelLineNo: { height: 10, width: 24, borderRadius: 4, backgroundColor: T.surface },
  skelLine: { height: 10, borderRadius: 4, backgroundColor: T.surface },
  diffLine: { paddingHorizontal: 12, fontFamily: "JetBrainsMono", fontSize: 11, lineHeight: 18 },
});
