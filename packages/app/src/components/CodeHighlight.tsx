import { memo, useMemo } from "react";
import { Text, View } from "react-native";
import { useGround } from "../ui/useThemeHex";
import { StyleSheet } from "react-native-unistyles";
import { highlightLines, themeFor } from "./highlight";
import { classifyLine, extOf, splitPatch } from "./diffPatch";

// Rangi ships bash/ruby/java/toml/scss and 80-odd more in one zero-dependency
// package, so the old `globalThis.Prism = …`-before-static-`require()` dance
// (and its "one missing grammar dependency breaks every tokenize" hazard) is gone.

const MONO = "JetBrainsMono";

/**
 * Inline, Prism-highlighted code as nested <Text> — flows inside a flex row and
 * wraps or truncates like normal text. The shared primitive behind the tool-card
 * command line and each diff line, so highlighting stays consistent with the
 * markdown code blocks. The Prism theme wants STRING colors, so the theme +
 * fallback token color are picked per system scheme, not from T.
 */
export const HlText = memo(function HlText({
  code,
  language,
  size = 12,
  numberOfLines,
}: {
  code: string;
  language: string;
  size?: number;
  numberOfLines?: number;
}) {
  const light = useGround() === "light";
  const hlTheme = themeFor(light);
  const lines = useMemo(() => highlightLines(code, language, light), [code, language, light]);
  return (
    <Text
      numberOfLines={numberOfLines}
      style={{ fontFamily: MONO, fontSize: size, lineHeight: size + 5.5 }}
    >
      {lines.map((spans, i) => (
        <Text key={i}>
          {i > 0 ? "\n" : ""}
          {spans.map((span, j) => (
            <Text key={j} style={{ color: span.color ?? hlTheme.fg }}>
              {span.text}
            </Text>
          ))}
        </Text>
      ))}
    </Text>
  );
});

/**
 * A unified-diff patch rendered GitHub-style natively (no WebView, so it's light
 * enough for the timeline): a per-file header with +/− counts, hunk markers, and
 * add / delete / context lines tinted by kind with their code content
 * syntax-highlighted for the file's language. Long diffs are capped.
 */
export const DiffBlock = memo(function DiffBlock({
  patch,
  path,
  maxLines = 90,
  nested,
}: {
  patch: string;
  path?: string;
  maxLines?: number;
  nested?: boolean;
}) {
  const light = useGround() === "light";
  const files = splitPatch(patch);
  // Not a `diff --git` multi-file patch (e.g. a bare hunk) — render it as one.
  if (!files.length) files.push({ path: path ?? "diff", text: patch, adds: 0, dels: 0 });

  return (
    <View
      style={[s.card, nested && s.cardNested, { backgroundColor: light ? "#f6f8fa" : "#0d0d12" }]}
    >
      {files.map((file, fi) => {
        const lang = EXT_LANG[extOf(file.path)] ?? "";
        // Drop git-meta lines (diff --git / index / +++ / ---) — the header names the file.
        const rows = file.text.split("\n").filter((l) => classifyLine(l) !== "header");
        const shown = rows.slice(0, maxLines);
        return (
          <View key={fi}>
            <View style={s.fileHeader}>
              <Text numberOfLines={1} style={s.filePath}>
                {file.path}
              </Text>
              {file.adds ? <Text style={s.addCount}>+{file.adds}</Text> : null}
              {file.dels ? <Text style={s.delCount}>−{file.dels}</Text> : null}
            </View>
            <View style={s.fileBody}>
              {shown.map((line, i) => {
                const kind = classifyLine(line);
                if (kind === "hunk") {
                  return (
                    <Text key={i} style={s.hunk}>
                      {line}
                    </Text>
                  );
                }
                const prefix = kind === "add" ? "+" : kind === "del" ? "−" : " ";
                const content = /^[+\- ]/.test(line) ? line.slice(1) : line;
                return (
                  <View
                    key={i}
                    style={[s.line, kind === "add" && s.lineAdd, kind === "del" && s.lineDel]}
                  >
                    <Text
                      style={[
                        s.prefix,
                        kind === "add" ? s.prefixAdd : kind === "del" ? s.prefixDel : s.prefixCtx,
                      ]}
                    >
                      {prefix}
                    </Text>
                    <View style={s.lineCode}>
                      <HlText code={content} language={lang} size={11.5} />
                    </View>
                  </View>
                );
              })}
              {rows.length > maxLines ? (
                <Text style={s.more}>… {rows.length - maxLines} more lines</Text>
              ) : null}
            </View>
          </View>
        );
      })}
    </View>
  );
});

/** File extension (`.ts`, `.json`, or `other`) → highlighter language id. */
const EXT_LANG: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "jsx",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".rb": "ruby",
  ".sh": "bash",
  ".zsh": "bash",
  ".bash": "bash",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".json": "json",
  ".md": "markdown",
  ".css": "css",
  ".scss": "scss",
  ".html": "html",
  ".xml": "xml",
  ".svg": "svg",
  ".sql": "sql",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".swift": "swift",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".toml": "toml",
  ".php": "php",
  ".rb2": "ruby",
};

const s = StyleSheet.create((theme) => ({
  card: { overflow: "hidden", borderRadius: 12, borderWidth: 1, borderColor: theme.colors.border },
  cardNested: { borderRadius: 8 },
  fileHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderBottomWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  filePath: { flex: 1, fontFamily: MONO, fontSize: 11, color: theme.colors.fgMuted },
  addCount: { fontSize: 11, fontWeight: "600", color: theme.colors.diffAddFg },
  delCount: { fontSize: 11, fontWeight: "600", color: theme.colors.diffDelFg },
  fileBody: { paddingVertical: 4 },
  hunk: { paddingHorizontal: 8, fontFamily: MONO, fontSize: 11, color: theme.colors.info },
  line: { flexDirection: "row", paddingHorizontal: 8 },
  lineAdd: { backgroundColor: theme.colors.diffAddBg },
  lineDel: { backgroundColor: theme.colors.diffDelBg },
  prefix: { width: 12, fontFamily: MONO, fontSize: 11 },
  prefixAdd: { color: theme.colors.diffAddFg },
  prefixDel: { color: theme.colors.diffDelFg },
  prefixCtx: { color: theme.colors.fgFaint },
  lineCode: { flex: 1 },
  more: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    fontFamily: MONO,
    fontSize: 11,
    color: theme.colors.fgFaint,
  },
}));
