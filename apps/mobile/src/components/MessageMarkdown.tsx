import { Component, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import {
  EnrichedMarkdownText,
  type MarkdownStyle,
  type Md4cFlags,
} from "react-native-enriched-markdown";
import remend from "remend";
import { splitShellBlocks } from "@/components/runnableBlocks";
import { COLOR } from "@/ui";

const MONO = "JetBrainsMono";
const SHELL_GOLD = "#d29922";

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
  code: { fontFamily: MONO, fontSize: 13, color: "#cdd0d6", backgroundColor: "#1b1b22" },
  codeBlock: { fontFamily: MONO, fontSize: 13, color: "#cdd0d6", backgroundColor: "#0d0d12", borderColor: "#26262f", borderWidth: 1, borderRadius: 10, padding: 10 },
  blockquote: { borderColor: "#33333e", borderWidth: 3, gapWidth: 8, backgroundColor: "transparent" },
  list: { bulletColor: COLOR.fgMuted, markerColor: COLOR.fgMuted, gapWidth: 6 },
  table: { borderColor: "#26262f", borderWidth: 1 },
  thematicBreak: { color: "#26262f", height: 1, marginTop: 6, marginBottom: 6 },
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
  code: { fontFamily: MONO, fontSize: 13, color: "#f4f2ff", backgroundColor: "rgba(255,255,255,0.18)" },
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
  // Only assistant turns, once settled, and only when running is possible.
  if (role !== "assistant" || streaming || !onRun) {
    return <MarkdownBody text={text} role={role} streaming={streaming} />;
  }
  const segments = splitShellBlocks(text);
  if (segments.length === 1 && segments[0].type === "md") {
    return <MarkdownBody text={text} role="assistant" />;
  }
  return (
    <View style={{ gap: 8 }}>
      {segments.map((seg, i) =>
        seg.type === "run" ? (
          <RunnableCodeBlock key={`r${i}`} command={seg.command} onRun={onRun} />
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
      />
    </MarkdownErrorBoundary>
  );
}

/** A shell command from the assistant, as a "$ …" card with a Run button that
 *  queues `!command` into the composer for review. */
function RunnableCodeBlock({
  command,
  onRun,
}: {
  command: string;
  onRun: (command: string) => void;
}) {
  return (
    <View className="overflow-hidden rounded-xl border border-border bg-surface-alt">
      <View className="flex-row items-start gap-2 px-3 py-2.5">
        <Text style={{ color: SHELL_GOLD }} className="font-mono text-[13px] font-semibold">
          $
        </Text>
        <Text className="flex-1 font-mono text-[12px] leading-[17px] text-fg">{command}</Text>
      </View>
      <Pressable
        onPress={() => onRun(command)}
        className="active:opacity-80 flex-row items-center justify-center gap-1.5 border-t border-border bg-accent-soft py-2"
      >
        <Ionicons name="play" size={13} color={COLOR.accent} />
        <Text className="text-[12px] font-semibold text-accent">Run</Text>
      </Pressable>
    </View>
  );
}

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
