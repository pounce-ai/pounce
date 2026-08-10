import { Component, memo, type ReactNode, useMemo, useRef, useState } from "react";
// eslint-disable-next-line @react-native/no-deprecated-api -- core Clipboard is
// the only clipboard already inside shipped binaries (OTA-safe); expo-clipboard
// would need a new native module and a store build.
import {
  ActivityIndicator,
  Clipboard,
  Pressable,
  ScrollView,
  Text,
  useColorScheme,
  View,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { PounceIcon } from "../ui/native/Icon";
import {
  EnrichedMarkdownText,
  type MarkdownStyle,
  type Md4cFlags,
} from "react-native-enriched-markdown";

/** One extra action on the native text-selection menu. Derived from the
 *  component's own props rather than imported by name: the package exports two
 *  different `ContextMenuItem`s (text vs. text-input) and the bare name
 *  resolves to the wrong one. */
export type MarkdownContextMenuItem = NonNullable<
  React.ComponentProps<typeof EnrichedMarkdownText>["contextMenuItems"]
>[number];
import { highlightLines, themeFor } from "./highlight";
import * as WebBrowser from "expo-web-browser";
import { StreamdownText } from "react-native-streamdown";
import type { RemendOptions } from "remend";
import { isDestructive, splitCodeBlocks } from "../components/runnableBlocks";
import { usePacedText } from "./pacedText";
import { COLOR } from "../ui";
import { useThemeHex } from "../ui/useThemeHex";
import type { PaletteHex } from "../ui/palettes";
import { SECONDARY_SCALE } from "../ui/tokens";

const MONO = "JetBrainsMono";

/** Executes a command on the thread's host and resolves with its result (null
 *  when there's no host to run on). See Session's onRunCommand. */
export type RunCommand = (command: string) => Promise<{ code: number; output: string } | null>;

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
 *  palette (never at module scope) — memoized per scheme and theme below. The
 *  palette arrives as an argument rather than a hook call: these are plain
 *  builders, run inside a useMemo. */
function buildAssistantStyle(scheme: string | null | undefined, hex: PaletteHex): MarkdownStyle {
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
    // Accent chip so inline code pops out of prose — the enriched default
    // gives inline code a pink border, so pin the border to the fill to hide
    // it. Both come from the ACTIVE theme's accent (see `accentInk` in
    // ui/palettes.ts): this used to be the brand purple hardcoded, which left
    // a violet chip sitting in the middle of a green or amber theme.
    code: {
      fontFamily: MONO,
      fontSize: 13.5,
      color: hex.accentInk,
      backgroundColor: hex.accentWash,
      borderColor: hex.accentWash,
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

/**
 * Same, on the user bubble.
 *
 * The bubble used to be painted in the brand accent, so every token in here was
 * forced to white to survive it. It is now a neutral elevated surface — the
 * same weight as a code card — which means the user's own words no longer need
 * to shout over a saturated background, and the accent is free for things that
 * are actually actionable. So this is the assistant palette with only the two
 * things that genuinely differ on a raised surface: inset fills need to read
 * against `bgElevated` rather than the page, so they step DOWN to the page
 * colour instead of up.
 */
function buildUserStyle(scheme: string | null | undefined, hex: PaletteHex): MarkdownStyle {
  const assistant = buildAssistantStyle(scheme, hex);
  const light = scheme === "light";
  return {
    ...assistant,
    paragraph: { fontSize: 15, lineHeight: 21, color: hex.fg, marginTop: 0, marginBottom: 4 },
    // Inline code sits ON the bubble, so it takes the page colour to read as an
    // inset; against the assistant's own code fill it would disappear.
    code: {
      fontFamily: MONO,
      fontSize: 13.5,
      color: light ? "#1f2328" : "#cdd0d6",
      backgroundColor: hex.bg,
      borderColor: hex.border,
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
  singleBlock,
  contextMenuItems,
  secondary,
}: {
  text: string;
  role: "user" | "assistant";
  streaming?: boolean;
  /** Present only for live assistant turns — enables command cards. Resolves
   *  with the command's result so the card can show it. */
  onRun?: RunCommand;
  /** Render the whole text as ONE markdown view instead of lifting code blocks
   *  into separate cards. Used where the text is a document rather than a chat
   *  turn (the project-context reader), so a selection can span the whole
   *  thing — a selection can't cross two sibling views. */
  singleBlock?: boolean;
  /** Extra actions on the native text-selection menu, e.g. "Comment". */
  contextMenuItems?: MarkdownContextMenuItem[];
  /** Render as secondary material rather than a conversation turn — see
   *  SECONDARY_SCALE. */
  secondary?: boolean;
}) {
  const scale = secondary ? SECONDARY_SCALE : 1;
  // User turns and live streaming (incomplete fences) stay on the native
  // markdown path; settled assistant turns get syntax-highlighted code blocks.
  // Memoized so a row re-render (recycling, marker toggle) doesn't re-split.
  const highlight = role === "assistant" && !streaming && !singleBlock;
  const segments = useMemo(() => (highlight ? splitCodeBlocks(text) : null), [highlight, text]);
  if (!highlight || !segments) {
    return (
      <MarkdownBody
        text={text}
        role={role}
        streaming={streaming}
        contextMenuItems={contextMenuItems}
        scale={scale}
      />
    );
  }
  if (segments.length === 1 && segments[0].type === "md") {
    return (
      <MarkdownBody
        text={text}
        role="assistant"
        contextMenuItems={contextMenuItems}
        scale={scale}
      />
    );
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
            secondary={secondary}
          />
        ) : (
          <MarkdownBody key={`m${i}`} text={seg.text} role="assistant" scale={scale} />
        ),
      )}
    </View>
  );
}

/** One markdown span rendered by the native engine, with a plain-text fallback. */

function scaleStyle(style: MarkdownStyle, scale: number): MarkdownStyle {
  if (scale === 1) return style;
  const round = (n: number) => Math.round(n * scale * 10) / 10;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(style)) {
    if (!value || typeof value !== "object") {
      out[key] = value;
      continue;
    }
    const entry: Record<string, unknown> = { ...(value as Record<string, unknown>) };
    if (typeof entry.fontSize === "number") entry.fontSize = round(entry.fontSize);
    if (typeof entry.lineHeight === "number") entry.lineHeight = round(entry.lineHeight);
    out[key] = entry;
  }
  return out as MarkdownStyle;
}

/**
 * Built style trees, shared by every message on screen.
 *
 * The inputs are all global — palette, role, scheme, scale — so the old
 * per-instance useMemo built ~25 nested objects per mounted row AND handed the
 * native renderer a distinct `markdownStyle` identity per row, which it can
 * never diff away. Keyed by the palette OBJECT (stable per theme, so a theme
 * switch simply lands on a fresh entry) then by the rest.
 */
const STYLE_CACHE = new WeakMap<PaletteHex, Map<string, MarkdownStyle>>();

function markdownStyleFor(
  role: "user" | "assistant",
  scheme: string | null | undefined,
  hex: PaletteHex,
  scale: number,
): MarkdownStyle {
  let byKey = STYLE_CACHE.get(hex);
  if (!byKey) {
    byKey = new Map();
    STYLE_CACHE.set(hex, byKey);
  }
  const key = `${role}|${scheme ?? ""}|${scale}`;
  let style = byKey.get(key);
  if (!style) {
    style = scaleStyle(
      role === "user" ? buildUserStyle(scheme, hex) : buildAssistantStyle(scheme, hex),
      scale,
    );
    byKey.set(key, style);
  }
  return style;
}

function MarkdownBody({
  text,
  role,
  streaming,
  contextMenuItems,
  scale = 1,
}: {
  text: string;
  role: "user" | "assistant";
  streaming?: boolean;
  contextMenuItems?: MarkdownContextMenuItem[];
  /** <1 renders the whole body one step down — see SECONDARY_SCALE. */
  scale?: number;
}) {
  const scheme = useColorScheme();
  const hex = useThemeHex();
  const markdownStyle = markdownStyleFor(role, scheme, hex, scale);
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
        contextMenuItems={contextMenuItems}
        onLinkPress={({ url }) => openLink(url)}
      />
    </MarkdownErrorBoundary>
  );
}

/**
 * A fenced code block: a code card with a language header (and a "Run" action
 * for shell blocks), syntax-highlighted and horizontally scrollable for long
 * lines. Highlight theme + card fill follow the system scheme. Language tags
 * are resolved in ./highlight — rangi knows our aliases natively.
 */
const CodeBlock = memo(function CodeBlock({
  lang,
  code,
  onRun,
  secondary,
}: {
  lang: string;
  code: string;
  /** Runs the command on the host and resolves with its result — see
   *  Session's onRunCommand. Absent on a thread that can't be steered. */
  onRun?: RunCommand;
  /** Match the surrounding secondary body so the card doesn't out-shout it. */
  secondary?: boolean;
}) {
  const codeSize = secondary ? 12.5 * SECONDARY_SCALE : 12.5;
  const codeLine = secondary ? 18 * SECONDARY_SCALE : 18;
  const { theme } = useUnistyles();
  const light = useColorScheme() === "light";
  const hlTheme = themeFor(light);
  // Highlighting is regex work over the whole block — keep it off the render
  // path for recycled rows that re-render on every marker/scroll tick.
  const lines = useMemo(() => highlightLines(code, lang, light), [code, lang, light]);
  // Brief "Copied" confirmation on the copy action; timer cleared on re-tap so
  // rapid taps don't flicker.
  const [copied, setCopied] = useState(false);
  // What this command did, once run — kept on the card so the output stays
  // beside the command that produced it rather than only in the turn below.
  const [result, setResult] = useState<{ code: number; output: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const risky = useMemo(() => isDestructive(code), [code]);
  // A tap on a risky command explains the hold rather than doing nothing —
  // silence would read as a broken button.
  const [armed, setArmed] = useState(false);
  const run = () => {
    if (busy) return;
    setArmed(false);
    setBusy(true);
    setResult(null);
    void onRun?.(code)
      .then(setResult)
      .finally(() => setBusy(false));
  };
  const warn = () => {
    setArmed(true);
    setTimeout(() => setArmed(false), 2500);
  };
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
            // A command that is hard to take back needs a deliberate gesture:
            // detection is a heuristic and the ARGUMENTS are whatever an agent
            // wrote, so `rm -rf build` reaches this button looking like `ls`.
            // A hold is the same bar any other irreversible control gets — and
            // it keeps the one-gesture flow, unlike a confirm dialog.
            onPress={risky ? warn : run}
            onLongPress={risky ? run : undefined}
            delayLongPress={550}
            disabled={busy}
            hitSlop={6}
            style={({ pressed }) => [s.action, pressed && s.pressed70]}
          >
            {busy ? (
              <ActivityIndicator size="small" color={theme.colors.accent} />
            ) : (
              <PounceIcon
                name={risky ? "alert-circle" : "play"}
                size={12}
                color={risky ? theme.colors.warning : theme.colors.accent}
              />
            )}
            <Text style={[s.runLabel, risky && { color: theme.colors.warning }]}>
              {busy ? "Running…" : risky ? (armed ? "Hold to run" : "Run") : "Run"}
            </Text>
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
        <View>
          {lines.map((spans, i) => (
            <View key={i} style={s.codeLine}>
              {spans.length === 0 ? (
                <Text style={{ fontSize: codeSize, lineHeight: codeLine }}> </Text>
              ) : null}
              {spans.map((span, j) => (
                <Text
                  key={j}
                  style={{
                    fontFamily: MONO,
                    fontSize: codeSize,
                    lineHeight: codeLine,
                    color: span.color ?? hlTheme.fg,
                  }}
                >
                  {span.text}
                </Text>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
      {/* What it actually did. Shown here as well as in the turn below, so the
          output stays attached to the command that produced it. */}
      {result ? (
        <View style={s.resultBox}>
          <Text style={result.code === 0 ? s.resultOk : s.resultFail}>
            {result.code === 0 ? "Ran · exit 0" : `Failed · exit ${result.code}`}
          </Text>
          {result.output.trim() ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <Text style={s.resultText}>{result.output.trim()}</Text>
            </ScrollView>
          ) : null}
        </View>
      ) : null}
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
  resultBox: {
    gap: 4,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  resultOk: { fontSize: 11, fontWeight: "600", color: theme.colors.success },
  resultFail: { fontSize: 11, fontWeight: "600", color: theme.colors.danger },
  resultText: { fontFamily: MONO, fontSize: 11.5, lineHeight: 16, color: theme.colors.fgMuted },
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
