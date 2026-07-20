import { memo } from "react";
import { StyleSheet, Text, useColorScheme, View } from "react-native";
import { Highlight, Prism, themes } from "prism-react-renderer";
import { classifyLine, extOf, splitPatch } from "./diffPatch";
import { T } from "../ui/theme";

// prism-react-renderer bundles a limited language set (no bash/ruby/java/…), so
// a shell command or a non-TS diff would fall back to plain text. Register the
// extra grammars onto its Prism instance. Order matters: the prismjs component
// files attach to globalThis.Prism, so set it BEFORE requiring them — require()
// runs in statement order, whereas `import` is hoisted. Static paths only, so
// Metro can resolve them. This also lights up ```bash markdown blocks (same Prism).
// Only self-contained grammars: these depend on clike/css (already bundled).
// Avoid ones needing markup-templating (php) — it registers a global
// after-tokenize hook that then crashes EVERY tokenize when the dep is missing.
(globalThis as { Prism?: unknown }).Prism = Prism;
/* eslint-disable @typescript-eslint/no-require-imports */
require("prismjs/components/prism-bash");
require("prismjs/components/prism-ruby");
require("prismjs/components/prism-java");
require("prismjs/components/prism-toml");
require("prismjs/components/prism-scss");
/* eslint-enable @typescript-eslint/no-require-imports */

const MONO = "JetBrainsMono";

/** Language tags / file extensions → Prism language ids. Unknown → plain. */
const PRISM_LANG: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
  py: "python", rb: "ruby", sh: "bash", shell: "bash", zsh: "bash", bash: "bash", console: "bash",
  "shell-session": "bash", yml: "yaml", yaml: "yaml", json: "json", md: "markdown", markdown: "markdown",
  "c++": "cpp", cpp: "cpp", cc: "cpp", "c#": "csharp", cs: "csharp", c: "c", h: "c", rs: "rust",
  go: "go", java: "java", kt: "kotlin", swift: "swift", css: "css", scss: "scss", html: "markup",
  xml: "markup", svg: "markup", sql: "sql", toml: "toml", diff: "diff", rb2: "ruby", php: "php",
};
export function prismLang(tag: string): string {
  const t = tag.replace(/^\./, "").toLowerCase();
  return PRISM_LANG[t] ?? t;
}

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
  const light = useColorScheme() === "light";
  return (
    <Highlight code={code} language={prismLang(language) || "text"} theme={light ? themes.github : themes.vsDark}>
      {({ tokens, getTokenProps }) => (
        <Text numberOfLines={numberOfLines} style={{ fontFamily: MONO, fontSize: size, lineHeight: size + 5.5 }}>
          {tokens.map((line, i) => (
            <Text key={i}>
              {i > 0 ? "\n" : ""}
              {line.map((token, j) => {
                const { style } = getTokenProps({ token });
                return (
                  <Text
                    key={j}
                    style={{
                      color: (style?.color as string) ?? (light ? "#24292e" : "#cdd0d6"),
                      fontStyle: style?.fontStyle as "italic" | undefined,
                    }}
                  >
                    {token.content}
                  </Text>
                );
              })}
            </Text>
          ))}
        </Text>
      )}
    </Highlight>
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
  const light = useColorScheme() === "light";
  const files = splitPatch(patch);
  // Not a `diff --git` multi-file patch (e.g. a bare hunk) — render it as one.
  if (!files.length) files.push({ path: path ?? "diff", text: patch, adds: 0, dels: 0 });

  return (
    <View style={[s.card, nested && s.cardNested, { backgroundColor: light ? "#f6f8fa" : "#0d0d12" }]}>
      {files.map((file, fi) => {
        const lang = EXT_LANG[extOf(file.path)] ?? "";
        // Drop git-meta lines (diff --git / index / +++ / ---) — the header names the file.
        const rows = file.text.split("\n").filter((l) => classifyLine(l) !== "header");
        const shown = rows.slice(0, maxLines);
        return (
          <View key={fi}>
            <View style={s.fileHeader}>
              <Text numberOfLines={1} style={s.filePath}>{file.path}</Text>
              {file.adds ? <Text style={s.addCount}>+{file.adds}</Text> : null}
              {file.dels ? <Text style={s.delCount}>−{file.dels}</Text> : null}
            </View>
            <View style={s.fileBody}>
              {shown.map((line, i) => {
                const kind = classifyLine(line);
                if (kind === "hunk") {
                  return <Text key={i} style={s.hunk}>{line}</Text>;
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

/** File extension (`.ts`, `.json`, or `other`) → Prism language. */
const EXT_LANG: Record<string, string> = {
  ".ts": "typescript", ".tsx": "tsx", ".js": "javascript", ".jsx": "jsx", ".mjs": "javascript",
  ".cjs": "javascript", ".py": "python", ".rb": "ruby", ".sh": "bash", ".zsh": "bash", ".bash": "bash",
  ".yml": "yaml", ".yaml": "yaml", ".json": "json", ".md": "markdown", ".css": "css", ".scss": "scss",
  ".html": "markup", ".xml": "markup", ".svg": "markup", ".sql": "sql", ".go": "go", ".rs": "rust",
  ".java": "java", ".kt": "kotlin", ".swift": "swift", ".c": "c", ".h": "c", ".cpp": "cpp", ".cc": "cpp",
  ".toml": "toml", ".php": "php", ".rb2": "ruby",
};

const s = StyleSheet.create({
  card: { overflow: "hidden", borderRadius: 12, borderWidth: 1, borderColor: T.border },
  cardNested: { borderRadius: 8 },
  fileHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderBottomWidth: 1,
    borderColor: T.border,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  filePath: { flex: 1, fontFamily: MONO, fontSize: 11, color: T.fgMuted },
  addCount: { fontSize: 11, fontWeight: "600", color: T.diffAddFg },
  delCount: { fontSize: 11, fontWeight: "600", color: T.diffDelFg },
  fileBody: { paddingVertical: 4 },
  hunk: { paddingHorizontal: 8, fontFamily: MONO, fontSize: 11, color: T.info },
  line: { flexDirection: "row", paddingHorizontal: 8 },
  lineAdd: { backgroundColor: T.diffAddBg },
  lineDel: { backgroundColor: T.diffDelBg },
  prefix: { width: 12, fontFamily: MONO, fontSize: 11 },
  prefixAdd: { color: T.diffAddFg },
  prefixDel: { color: T.diffDelFg },
  prefixCtx: { color: T.fgFaint },
  lineCode: { flex: 1 },
  more: { paddingHorizontal: 8, paddingVertical: 4, fontFamily: MONO, fontSize: 11, color: T.fgFaint },
});
