import { Component, memo, type ReactNode, useMemo } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import {
  EnrichedMarkdownText,
  type MarkdownStyle,
  type Md4cFlags,
} from "react-native-enriched-markdown";
import { Highlight, themes } from "prism-react-renderer";
import * as WebBrowser from "expo-web-browser";
import remend from "remend";
import { splitCodeBlocks } from "../components/runnableBlocks";
import { COLOR } from "../ui";

const MONO = "JetBrainsMono";

/** Open tapped links in an in-app browser (SFSafariViewController / Custom Tabs)
 *  so the user stays inside Pounce instead of being kicked out to Safari. Only
 *  http(s) opens in-app; other schemes are ignored (the engine won't hand us one
 *  in practice). */
function openLink(url: string): void {
  if (/^https?:\/\//i.test(url)) void WebBrowser.openBrowserAsync(url).catch(() => {});
}

/** latex on for the assistant's math; underline/sub/superscript off so prose
 *  like a__b or ~n isn't reinterpreted. GFM strikethrough comes from
 *  flavor="github". */
const MD4C_FLAGS: Md4cFlags = {
  underline: false,
  latexMath: true,
  superscript: false,
  subscript: false,
  highlight: false,
};

/** Markdown styling mapped onto Pounce tokens, for text rendered on the dark
 *  surface (assistant bubbles, folder/thread bodies). */
const ASSISTANT_STYLE: MarkdownStyle = {
  paragraph: { fontSize: 15, lineHeight: 21, color: COLOR.fg, marginTop: 0, marginBottom: 6 },
  h1: { fontSize: 20, fontWeight: "700", color: COLOR.fg, marginTop: 2, marginBottom: 6 },
  h2: { fontSize: 18, fontWeight: "700", color: COLOR.fg, marginTop: 2, marginBottom: 6 },
  h3: { fontSize: 16, fontWeight: "700", color: COLOR.fg, marginTop: 2, marginBottom: 4 },
  h4: { fontSize: 15, fontWeight: "600", color: COLOR.fg, marginTop: 2, marginBottom: 4 },
  h5: { fontSize: 15, fontWeight: "600", color: COLOR.fgMuted, marginTop: 2, marginBottom: 2 },
  h6: { fontSize: 14, fontWeight: "600", color: COLOR.fgMuted, marginTop: 2, marginBottom: 2 },
  strong: { fontWeight: "bold", color: COLOR.fg },
  em: { fontStyle: "italic", color: COLOR.fg },
  strikethrough: { color: COLOR.fgMuted },
  link: { color: COLOR.accent, underline: false },
  // Subtle chip — the enriched default gives inline code a pink border, so pin
  // the border to the fill to hide it.
  code: { fontFamily: MONO, fontSize: 13.5, color: "#e6c07b", backgroundColor: "#23232c", borderColor: "#23232c" },
  codeBlock: { fontFamily: MONO, fontSize: 13, color: "#cdd0d6", backgroundColor: "#0d0d12", borderColor: "#26262f", borderWidth: 1, borderRadius: 10, padding: 10 },
  blockquote: { color: COLOR.fgMuted, borderColor: "#33333e", borderWidth: 3, gapWidth: 10, backgroundColor: "transparent" },
  // list.color defaults to a light-theme color (invisible on dark) — set it.
  list: { color: COLOR.fg, bulletColor: COLOR.fgMuted, markerColor: COLOR.fgMuted, gapWidth: 8 },
  // Table defaults are light-theme (white bg / near-black text) — theme it dark.
  table: {
    color: COLOR.fg,
    headerBackgroundColor: "#1b1b22",
    headerTextColor: COLOR.fg,
    rowEvenBackgroundColor: "#141419",
    rowOddBackgroundColor: "#101016",
    borderColor: "#2b2b35",
    borderWidth: 1,
    borderRadius: 8,
  },
  thematicBreak: { color: "#26262f", height: 1, marginTop: 8, marginBottom: 8 },
};

/** Same, but on the accent (user) bubble — text is white-on-purple. */
const USER_STYLE: MarkdownStyle = {
  ...ASSISTANT_STYLE,
  paragraph: { fontSize: 15, lineHeight: 21, color: "#ffffff", marginTop: 0, marginBottom: 4 },
  strong: { fontWeight: "bold", color: "#ffffff" },
  em: { fontStyle: "italic", color: "#ffffff" },
  h1: { ...ASSISTANT_STYLE.h1, color: "#ffffff" },
  h2: { ...ASSISTANT_STYLE.h2, color: "#ffffff" },
  h3: { ...ASSISTANT_STYLE.h3, color: "#ffffff" },
  link: { color: "#ffffff", underline: true },
  code: { fontFamily: MONO, fontSize: 13.5, color: "#f4f2ff", backgroundColor: "rgba(255,255,255,0.20)", borderColor: "rgba(255,255,255,0.20)" },
  list: { color: "#ffffff", bulletColor: "rgba(255,255,255,0.7)", markerColor: "rgba(255,255,255,0.7)", gapWidth: 8 },
};

/**
 * Renders a message body as rich markdown (native md4c via
 * react-native-enriched-markdown). Assistant and user turns share one engine so
 * styling stays consistent; the user now composes markdown too.
 *
 * When `onRun` is provided (a live assistant turn), finalized text is split so
 * shell code blocks render as tappable "Run" cards while the surrounding prose
 * stays markdown. Streaming turns skip splitting (incomplete fences) and render
 * on the single markdown path, with partial text repaired by remend (closes
 * dangling **, `, ``` fences) so nothing renders as raw asterisks mid-stream.
 */
export function MessageMarkdown({
  text,
  role,
  streaming,
  onRun,
}: {
  text: string;
  role: "user" | "assistant";
  streaming?: boolean;
  /** Present only for live assistant turns — enables shell "Run" cards. */
  onRun?: (command: string) => void;
}) {
  // User turns and live streaming (incomplete fences) stay on the native
  // markdown path; settled assistant turns get syntax-highlighted code blocks.
  // Memoized so a row re-render (recycling, marker toggle) doesn't re-split.
  const highlight = role === "assistant" && !streaming;
  const segments = useMemo(() => (highlight ? splitCodeBlocks(text) : null), [highlight, text]);
  if (!highlight || !segments) {
    return <MarkdownBody text={text} role={role} streaming={streaming} />;
  }
  if (segments.length === 1 && segments[0].type === "md") {
    return <MarkdownBody text={text} role="assistant" />;
  }
  return (
    <View style={{ gap: 8 }}>
      {segments.map((seg, i) =>
        seg.type === "code" ? (
          <CodeBlock key={`c${i}`} lang={seg.lang} code={seg.code} onRun={seg.runnable ? onRun : undefined} />
        ) : (
          <MarkdownBody key={`m${i}`} text={seg.text} role="assistant" />
        ),
      )}
    </View>
  );
}

/** One markdown span rendered by the native engine, with a plain-text fallback. */
function MarkdownBody({
  text,
  role,
  streaming,
}: {
  text: string;
  role: "user" | "assistant";
  streaming?: boolean;
}) {
  const markdown = streaming ? remend(text) : text;
  return (
    <MarkdownErrorBoundary text={text} role={role}>
      <EnrichedMarkdownText
        markdown={markdown}
        markdownStyle={role === "user" ? USER_STYLE : ASSISTANT_STYLE}
        md4cFlags={MD4C_FLAGS}
        flavor="github"
        streamingAnimation={!!streaming}
        selectable={!streaming}
        onLinkPress={({ url }) => openLink(url)}
      />
    </MarkdownErrorBoundary>
  );
}

/** Map our fenced-block language tags to Prism language ids (aliases prism
 *  doesn't know natively). Unknown → passed through; empty → plain text. */
const PRISM_LANG: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
  py: "python", rb: "ruby", sh: "bash", shell: "bash", zsh: "bash", console: "bash",
  "shell-session": "bash", yml: "yaml", md: "markdown", "c++": "cpp", "c#": "csharp",
  text: "", txt: "", "": "",
};

/**
 * A fenced code block: a dark card with a language header (and a "Run" action for
 * shell blocks), Prism-highlighted and horizontally scrollable for long lines.
 */
const CodeBlock = memo(function CodeBlock({ lang, code, onRun }: { lang: string; code: string; onRun?: (c: string) => void }) {
  const prismLang = PRISM_LANG[lang] ?? lang;
  return (
    <View className="overflow-hidden rounded-xl border border-border bg-[#0d0d12]">
      {lang || onRun ? (
        <View className="flex-row items-center gap-2 border-b border-border/70 px-3 py-1.5">
          <Text className="flex-1 font-mono text-[11px] lowercase text-fg-faint">{lang || "code"}</Text>
          {onRun ? (
            <Pressable onPress={() => onRun(code)} hitSlop={6} className="active:opacity-70 flex-row items-center gap-1">
              <Ionicons name="play" size={12} color={COLOR.accent} />
              <Text className="text-[12px] font-semibold text-accent">Run</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ padding: 10 }}>
        <Highlight code={code} language={prismLang || "text"} theme={themes.vsDark}>
          {({ tokens, getTokenProps }) => (
            <View>
              {tokens.map((line, i) => (
                <View key={i} className="flex-row">
                  {line.length === 0 ? <Text style={{ fontSize: 12.5, lineHeight: 18 }}> </Text> : null}
                  {line.map((token, j) => {
                    const { style } = getTokenProps({ token });
                    return (
                      <Text
                        key={j}
                        style={{
                          fontFamily: MONO,
                          fontSize: 12.5,
                          lineHeight: 18,
                          color: (style?.color as string) ?? "#cdd0d6",
                          fontStyle: style?.fontStyle as "italic" | undefined,
                        }}
                      >
                        {token.content}
                      </Text>
                    );
                  })}
                </View>
              ))}
            </View>
          )}
        </Highlight>
      </ScrollView>
    </View>
  );
});

class MarkdownErrorBoundary extends Component<
  { text: string; role: "user" | "assistant"; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  // A different message means a fresh render — clear the flag so one bad message
  // doesn't poison a recycled row.
  override componentDidUpdate(prev: { text: string }) {
    if (prev.text !== this.props.text && this.state.failed) this.setState({ failed: false });
  }
  override render() {
    if (this.state.failed) {
      const color = this.props.role === "user" ? "#ffffff" : COLOR.fg;
      return <Text style={{ fontSize: 15, lineHeight: 21, color }}>{this.props.text}</Text>;
    }
    return this.props.children;
  }
}
