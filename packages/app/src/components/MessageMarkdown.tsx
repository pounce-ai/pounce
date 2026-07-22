import { Component, memo, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
// eslint-disable-next-line @react-native/no-deprecated-api -- core Clipboard is
// the only clipboard already inside shipped binaries (OTA-safe); expo-clipboard
// would need a new native module and a store build.
import { Clipboard, Pressable, ScrollView, Text, useColorScheme, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { PounceIcon } from "../ui/native/Icon";
import {
  EnrichedMarkdownText,
  type MarkdownStyle,
  type Md4cFlags,
} from "react-native-enriched-markdown";
import { Highlight, themes } from "prism-react-renderer";
import * as WebBrowser from "expo-web-browser";
import { StreamdownText } from "react-native-streamdown";
import type { RemendOptions } from "remend";
import { splitCodeBlocks } from "../components/runnableBlocks";
import { COLOR } from "../ui";
import { hexFor } from "../ui/theme-hex";

const MONO = "JetBrainsMono";

/** Grok-style reveal pacing: the bridge streams text in sentence-sized chunks,
 *  and splashing a whole chunk at once defeats the native tail fade-in. This
 *  parcels growth out a few words per tick instead — the engine animates each
 *  increment — with an adaptive step so a big chunk drains in under a second
 *  and the shown text never trails the real stream far. Non-append updates
 *  (recycled row, rewritten buffer) and the settled state pass through
 *  verbatim; the first mount does too, so reopening a mid-stream thread
 *  doesn't replay the whole message. */
function usePacedText(target: string, enabled: boolean): string {
  const [shown, setShown] = useState(target);
  const shownRef = useRef(target);
  useEffect(() => {
    if (!enabled || !target.startsWith(shownRef.current)) {
      shownRef.current = target;
      setShown(target);
      return;
    }
    if (target.length === shownRef.current.length) return;
    const timer = setInterval(() => {
      const cur = shownRef.current;
      if (cur.length >= target.length) {
        clearInterval(timer);
        return;
      }
      // A steady 1–2 words per tick is what makes the reveal read as calm —
      // the native tail fade softens each small step into a shimmer, and the
      // list's pin-to-end moves in matching small nudges. Only a deep backlog
      // (a burst chunk) drains faster, and even then gently.
      const backlog = target.length - cur.length;
      const steps = backlog > 600 ? 4 : backlog > 250 ? 2 : 1;
      let next = cur.length;
      for (let i = 0; i < steps && next < target.length; i++) {
        const ws = target.slice(next + 1).search(/\s/);
        next = ws === -1 ? target.length : next + 1 + ws;
      }
      shownRef.current = target.slice(0, next);
      setShown(shownRef.current);
    }, 40);
    return () => clearInterval(timer);
  }, [target, enabled]);
  return enabled ? shown : target;
}

/** Open tapped links in an in-app browser (SFSafariViewController / Custom Tabs)
 *  so the user stays inside Pounce instead of being kicked out to Safari. Only
 *  http(s) opens in-app; other schemes are ignored (the engine won't hand us one
 *  in practice). */
function openLink(url: string): void {
  if (/^https?:\/\//i.test(url)) void WebBrowser.openBrowserAsync(url).catch(() => {});
}

/** Streamdown merges this over its defaults. katex on to match latexMath below —
 *  otherwise a dangling $$ renders raw mid-stream. (Its default linkMode
 *  'text-only' stands: incomplete links show as plain text, never a dead tap
 *  target.) Module-scope so the reference is stable — the hook re-runs remend
 *  when this identity changes. */
const REMEND_CONFIG: RemendOptions = { katex: true };

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

/** Markdown styling mapped onto Pounce tokens. The native engine requires
 *  STRING colors, so the styles are built per color scheme from the literal hex
 *  palette (never at module scope) — memoized per scheme below. */
function buildAssistantStyle(scheme: string | null | undefined): MarkdownStyle {
  const hex = hexFor(scheme);
  const light = scheme === "light";
  return {
    paragraph: { fontSize: 15, lineHeight: 21, color: hex.fg, marginTop: 0, marginBottom: 6 },
    h1: { fontSize: 20, fontWeight: "700", color: hex.fg, marginTop: 2, marginBottom: 6 },
    h2: { fontSize: 18, fontWeight: "700", color: hex.fg, marginTop: 2, marginBottom: 6 },
    h3: { fontSize: 16, fontWeight: "700", color: hex.fg, marginTop: 2, marginBottom: 4 },
    h4: { fontSize: 15, fontWeight: "600", color: hex.fg, marginTop: 2, marginBottom: 4 },
    h5: { fontSize: 15, fontWeight: "600", color: hex.fgMuted, marginTop: 2, marginBottom: 2 },
    h6: { fontSize: 14, fontWeight: "600", color: hex.fgMuted, marginTop: 2, marginBottom: 2 },
    strong: { fontWeight: "bold", color: hex.fg },
    em: { fontStyle: "italic", color: hex.fg },
    strikethrough: { color: hex.fgMuted },
    link: { color: hex.accent, underline: false },
    // Purple accent chip so inline code pops out of prose — the enriched default
    // gives inline code a pink border, so pin the border to the fill to hide it.
    code: light
      ? {
          fontFamily: MONO,
          fontSize: 13.5,
          color: "#5b4fd8",
          backgroundColor: "rgba(124,111,240,0.12)",
          borderColor: "rgba(124,111,240,0.12)",
        }
      : {
          fontFamily: MONO,
          fontSize: 13.5,
          color: "#a99cf5",
          backgroundColor: "rgba(124,111,240,0.16)",
          borderColor: "rgba(124,111,240,0.16)",
        },
    codeBlock: light
      ? {
          fontFamily: MONO,
          fontSize: 13,
          color: "#24292e",
          backgroundColor: "#f6f8fa",
          borderColor: "#e1e4e8",
          borderWidth: 1,
          borderRadius: 10,
          padding: 10,
        }
      : {
          fontFamily: MONO,
          fontSize: 13,
          color: "#cdd0d6",
          backgroundColor: "#0d0d12",
          borderColor: "#26262f",
          borderWidth: 1,
          borderRadius: 10,
          padding: 10,
        },
    blockquote: {
      color: hex.fgMuted,
      borderColor: light ? "#d0d0d7" : "#33333e",
      borderWidth: 3,
      gapWidth: 10,
      backgroundColor: "transparent",
    },
    // list.color defaults to a light-theme color — set it for both schemes.
    list: { color: hex.fg, bulletColor: hex.fgMuted, markerColor: hex.fgMuted, gapWidth: 8 },
    // Table defaults are light-theme (white bg / near-black text) — theme both.
    table: light
      ? {
          color: hex.fg,
          headerBackgroundColor: "#f2f2f6",
          headerTextColor: hex.fg,
          rowEvenBackgroundColor: "#ffffff",
          rowOddBackgroundColor: "#fafafc",
          borderColor: "#e1e4e8",
          borderWidth: 1,
          borderRadius: 8,
        }
      : {
          color: hex.fg,
          headerBackgroundColor: "#1b1b22",
          headerTextColor: hex.fg,
          rowEvenBackgroundColor: "#141419",
          rowOddBackgroundColor: "#101016",
          borderColor: "#2b2b35",
          borderWidth: 1,
          borderRadius: 8,
        },
    thematicBreak: {
      color: light ? "#e5e5ea" : "#26262f",
      height: 1,
      marginTop: 8,
      marginBottom: 8,
    },
  };
}

/** Same, but on the accent (user) bubble — white-on-purple in both schemes. */
function buildUserStyle(scheme: string | null | undefined): MarkdownStyle {
  const assistant = buildAssistantStyle(scheme);
  return {
    ...assistant,
    paragraph: { fontSize: 15, lineHeight: 21, color: "#ffffff", marginTop: 0, marginBottom: 4 },
    strong: { fontWeight: "bold", color: "#ffffff" },
    em: { fontStyle: "italic", color: "#ffffff" },
    h1: { ...assistant.h1, color: "#ffffff" },
    h2: { ...assistant.h2, color: "#ffffff" },
    h3: { ...assistant.h3, color: "#ffffff" },
    link: { color: "#ffffff", underline: true },
    code: {
      fontFamily: MONO,
      fontSize: 13.5,
      color: "#f4f2ff",
      backgroundColor: "rgba(255,255,255,0.20)",
      borderColor: "rgba(255,255,255,0.20)",
    },
    list: {
      color: "#ffffff",
      bulletColor: "rgba(255,255,255,0.7)",
      markerColor: "rgba(255,255,255,0.7)",
      gapWidth: 8,
    },
  };
}

/**
 * Renders a message body as rich markdown (native md4c via
 * react-native-enriched-markdown). Assistant and user turns share one engine so
 * styling stays consistent; the user now composes markdown too.
 *
 * When `onRun` is provided (a live assistant turn), finalized text is split so
 * shell code blocks render as tappable "Run" cards while the surrounding prose
 * stays markdown. Streaming turns skip splitting (incomplete fences) and render
 * via StreamdownText, which repairs partial text with remend (closes dangling
 * **, `, ``` fences) on a dedicated worklet runtime so per-token repair work
 * stays off the JS thread.
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
          <CodeBlock
            key={`c${i}`}
            lang={seg.lang}
            code={seg.code}
            onRun={seg.runnable ? onRun : undefined}
          />
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
  const scheme = useColorScheme();
  const markdownStyle = useMemo(
    () => (role === "user" ? buildUserStyle(scheme) : buildAssistantStyle(scheme)),
    [role, scheme],
  );
  const paced = usePacedText(text, !!streaming);
  // Live turns run remend off the JS thread (streamdown's remend-processor
  // worklet runtime — needs worklets bundle mode); settled turns skip remend
  // entirely, so the plain engine renders them directly.
  if (streaming) {
    return (
      <MarkdownErrorBoundary text={text} role={role}>
        <StreamdownText
          markdown={paced}
          remendConfig={REMEND_CONFIG}
          markdownStyle={markdownStyle}
          md4cFlags={MD4C_FLAGS}
          flavor="github"
          selectable={false}
          onLinkPress={({ url }) => openLink(url)}
        />
      </MarkdownErrorBoundary>
    );
  }
  return (
    <MarkdownErrorBoundary text={text} role={role}>
      <EnrichedMarkdownText
        markdown={text}
        markdownStyle={markdownStyle}
        md4cFlags={MD4C_FLAGS}
        flavor="github"
        selectable
        onLinkPress={({ url }) => openLink(url)}
      />
    </MarkdownErrorBoundary>
  );
}

/** Map our fenced-block language tags to Prism language ids (aliases prism
 *  doesn't know natively). Unknown → passed through; empty → plain text. */
const PRISM_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rb: "ruby",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  "shell-session": "bash",
  yml: "yaml",
  md: "markdown",
  "c++": "cpp",
  "c#": "csharp",
  text: "",
  txt: "",
  "": "",
};

/**
 * A fenced code block: a code card with a language header (and a "Run" action
 * for shell blocks), Prism-highlighted and horizontally scrollable for long
 * lines. Prism theme + card fill follow the system scheme.
 */
const CodeBlock = memo(function CodeBlock({
  lang,
  code,
  onRun,
}: {
  lang: string;
  code: string;
  onRun?: (c: string) => void;
}) {
  const { theme } = useUnistyles();
  const light = useColorScheme() === "light";
  const prismLang = PRISM_LANG[lang] ?? lang;
  // Brief "Copied" confirmation on the copy action; timer cleared on re-tap so
  // rapid taps don't flicker.
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copy = () => {
    Clipboard.setString(code);
    setCopied(true);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 1500);
  };
  return (
    <View style={[s.card, { backgroundColor: light ? "#f6f8fa" : "#0d0d12" }]}>
      {/* Header always renders so every block has a Copy affordance. */}
      <View style={s.cardHeader}>
        <Text style={s.lang}>{lang || "code"}</Text>
        {onRun ? (
          <Pressable
            onPress={() => onRun(code)}
            hitSlop={6}
            style={({ pressed }) => [s.action, pressed && s.pressed70]}
          >
            <PounceIcon name="play" size={12} color={theme.colors.accent} />
            <Text style={s.runLabel}>Run</Text>
          </Pressable>
        ) : null}
        <Pressable
          onPress={copy}
          hitSlop={6}
          style={({ pressed }) => [s.action, pressed && s.pressed70]}
        >
          <PounceIcon
            name={copied ? "checkmark" : "copy-outline"}
            size={12}
            color={copied ? theme.colors.success : theme.colors.fgMuted}
          />
          <Text
            style={[s.copyLabel, { color: copied ? theme.colors.success : theme.colors.fgMuted }]}
          >
            {copied ? "Copied" : "Copy"}
          </Text>
        </Pressable>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ padding: 10 }}
      >
        <Highlight
          code={code}
          language={prismLang || "text"}
          theme={light ? themes.github : themes.vsDark}
        >
          {({ tokens, getTokenProps }) => (
            <View>
              {tokens.map((line, i) => (
                <View key={i} style={s.codeLine}>
                  {line.length === 0 ? (
                    <Text style={{ fontSize: 12.5, lineHeight: 18 }}> </Text>
                  ) : null}
                  {line.map((token, j) => {
                    const { style } = getTokenProps({ token });
                    return (
                      <Text
                        key={j}
                        style={{
                          fontFamily: MONO,
                          fontSize: 12.5,
                          lineHeight: 18,
                          color: (style?.color as string) ?? (light ? "#24292e" : "#cdd0d6"),
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

const s = StyleSheet.create((theme) => ({
  card: { overflow: "hidden", borderRadius: 12, borderWidth: 1, borderColor: theme.colors.border },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderBottomWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  lang: {
    flex: 1,
    fontFamily: MONO,
    fontSize: 11,
    textTransform: "lowercase",
    color: theme.colors.fgFaint,
  },
  action: { flexDirection: "row", alignItems: "center", gap: 4 },
  runLabel: { fontSize: 12, fontWeight: "600", color: theme.colors.accent },
  copyLabel: { fontSize: 12, fontWeight: "600" },
  codeLine: { flexDirection: "row" },
  pressed70: { opacity: 0.7 },
}));
