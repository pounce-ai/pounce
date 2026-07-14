import { useEffect, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import PatchDiffDOM from "./PatchDiffDOM";
import { filterPatchByExt } from "./diffPatch";
import type { DiffViewProps } from "./DiffViewTypes";
import { cn } from "../ui";

/** How long the DOM renderer gets to report ready before we fall back. */
const DOM_READY_TIMEOUT_MS = 6000;

/**
 * Unified-diff viewer seam. Mobile: @pierre/diffs (syntax highlighting,
 * file headers, word-level change highlights) inside an Expo DOM component.
 * Desktop overrides this per-platform (DiffView.desktop.tsx) with a native
 * structured renderer — react-native-webview has no solid macOS build.
 *
 * The WebView boots blank before react-dom hydrates, so a skeleton covers it
 * until the DOM component reports ready; if that never happens (bundler issue,
 * webview failure), a plain native line renderer takes over.
 */
export function DiffView({ patch, layout = "unified", extFilter, seenPaths, onToggleSeen }: DiffViewProps) {
  const filtered = useMemo(() => filterPatchByExt(patch, extFilter), [patch, extFilter]);
  const [dom, setDom] = useState<"loading" | "ready" | "failed">("loading");

  useEffect(() => {
    if (dom !== "loading") return;
    const t = setTimeout(
      () => setDom((s) => (s === "loading" ? "failed" : s)),
      DOM_READY_TIMEOUT_MS,
    );
    return () => clearTimeout(t);
  }, [dom]);

  if (dom === "failed") return <FallbackDiff patch={filtered} />;

  return (
    <View className="flex-1">
      <PatchDiffDOM
        patch={filtered}
        diffStyle={layout}
        seenPaths={seenPaths}
        onToggleSeen={onToggleSeen}
        onReady={async () => setDom("ready")}
        dom={{
          style: { flex: 1, backgroundColor: "#0b0b0f", opacity: dom === "ready" ? 1 : 0 },
          containerStyle: { flex: 1 },
        }}
      />
      {dom === "loading" ? <DiffSkeleton /> : null}
    </View>
  );
}

/** File-section shaped placeholder shown while the DOM renderer boots. */
function DiffSkeleton() {
  return (
    <View className="absolute inset-0 bg-bg px-0 pt-1" pointerEvents="none">
      {[0, 1, 2].map((s) => (
        <View key={s}>
          <View className="mt-3 flex-row items-center gap-2 border-b border-t border-border bg-bg-elevated px-3 py-2.5">
            <View className="h-4 w-4 rounded bg-surface-hover" />
            <View className="h-3 flex-1 rounded bg-surface-hover" style={{ maxWidth: 180 + s * 40 }} />
            <View className="h-3 w-12 rounded bg-surface-hover" />
          </View>
          {[0, 1, 2, 3, 4].map((l) => (
            <View key={l} className="flex-row items-center gap-3 px-3 py-1">
              <View className="h-2.5 w-6 rounded bg-surface" />
              <View
                className="h-2.5 rounded bg-surface"
                style={{ width: `${30 + ((s * 5 + l * 37) % 55)}%` }}
              />
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

type Kind = "header" | "hunk" | "add" | "del" | "ctx";

function classify(line: string): Kind {
  if (line.startsWith("@@")) return "hunk";
  if (/^(diff --git|index |--- |\+\+\+ |new file|deleted file|rename )/.test(line)) return "header";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "ctx";
}

const LINE_CLASS: Record<Kind, string> = {
  header: "text-fg-faint",
  hunk: "text-info",
  add: "bg-diff-add-bg text-diff-add-fg",
  del: "bg-diff-del-bg text-diff-del-fg",
  ctx: "text-fg-muted",
};

/** Plain colored-line renderer — the escape hatch when the DOM viewer dies. */
function FallbackDiff({ patch }: { patch: string }) {
  const lines = useMemo(() => patch.split("\n"), [patch]);
  return (
    <ScrollView className="flex-1" contentContainerStyle={{ paddingVertical: 6 }}>
      {lines.map((line, i) => (
        <Text key={i} className={cn("px-3 font-mono text-[11px] leading-[18px]", LINE_CLASS[classify(line)])}>
          {line || " "}
        </Text>
      ))}
    </ScrollView>
  );
}
