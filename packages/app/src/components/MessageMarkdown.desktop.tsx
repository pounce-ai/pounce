/**
 * MessageMarkdown — desktop implementation.
 *
 * react-native-enriched-markdown is a native (Nitro-based) component with no
 * macOS/Windows build, so desktop renders messages with a small pure-JS
 * markdown renderer instead: headings, bold/italic, inline code, fenced code
 * blocks, lists, quotes, and styled links. Same exported surface as the
 * mobile implementation, including shell "Run" cards via runnableBlocks.
 */
import { Fragment, useMemo, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, useColorScheme, View, type TextStyle } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { COLOR } from "../ui";
import { T } from "../ui/theme";
import { splitCodeBlocks } from "./runnableBlocks";
import { highlightLines, themeFor } from "./highlight";
import { usePacedText } from "./pacedText";
import { SECONDARY_SCALE } from "../ui/tokens";

const BASE: Record<"user" | "assistant", TextStyle> = {
  user: { fontSize: 15, lineHeight: 21, color: T.onAccent },
  assistant: { fontSize: 15, lineHeight: 21, color: T.fg },
};

/** Mirrors the native `ContextMenuItem`, declared locally because the native
 *  markdown package has no desktop build to import the type from. */
export interface MarkdownContextMenuItem {
  text: string;
  onPress: (event: { text: string; selection: { start: number; end: number } }) => void;
  icon?: string;
  visible?: boolean;
}

export function MessageMarkdown({
  text,
  role,
  streaming,
  onRun,
  singleBlock,
  secondary,
}: {
  text: string;
  role: "user" | "assistant";
  streaming?: boolean;
  /** Present only for live assistant turns — enables shell "Run" cards. */
  onRun?: (command: string) => void;
  /** Render as one document rather than lifting code blocks into cards. */
  singleBlock?: boolean;
  /** Accepted for API parity and ignored: the desktop renderer is plain RN
   *  <Text>, which has no selection-menu hook. Callers that offer a
   *  select-to-comment action must also offer a button-driven path. */
  contextMenuItems?: MarkdownContextMenuItem[];
  /** Render as secondary material rather than a conversation turn — see
   *  SECONDARY_SCALE. */
  secondary?: boolean;
}) {
  const base = useMemo(() => {
    const b = BASE[role];
    if (!secondary) return b;
    const round = (n: number) => Math.round(n * SECONDARY_SCALE * 10) / 10;
    return {
      ...b,
      fontSize: round(b.fontSize as number),
      lineHeight: round(b.lineHeight as number),
    };
  }, [role, secondary]);
  const onUser = role === "user";
  // Settled assistant turns get code blocks lifted out (Run cards); streaming
  // turns render on the single path (incomplete fences would mis-split).
  const highlight = role === "assistant" && !streaming && !singleBlock;
  const segments = useMemo(() => (highlight ? splitCodeBlocks(text) : null), [highlight, text]);
  // Meter the reveal a couple of words at a time rather than letting whole
  // bridge chunks land at once. Only the streaming path uses it — `paced`
  // returns `text` verbatim once the turn settles.
  const paced = usePacedText(text, !!streaming);

  if (!highlight || !segments || (segments.length === 1 && segments[0].type === "md")) {
    return (
      <View style={s.gap2}>
        <Blocks text={paced} baseStyle={base} onUser={onUser} />
        {streaming ? <Text style={s.cursor}>▋</Text> : null}
      </View>
    );
  }
  return (
    <View style={{ gap: 8 }}>
      {segments.map((seg, i) =>
        seg.type === "code" ? (
          <CodeCard
            key={`c${i}`}
            lang={seg.lang}
            code={seg.code}
            onRun={seg.runnable ? onRun : undefined}
          />
        ) : (
          <Blocks key={`m${i}`} text={seg.text} baseStyle={base} onUser={onUser} />
        ),
      )}
    </View>
  );
}

/** A lifted fenced block: mono body, language tag, optional Run affordance. */
function CodeCard({
  lang,
  code,
  onRun,
}: {
  lang: string;
  code: string;
  onRun?: (command: string) => void;
}) {
  return (
    <View style={s.codeCard}>
      <View style={s.codeCardHeader}>
        <Text style={s.codeLang}>{lang || "code"}</Text>
        {onRun ? (
          <Pressable
            onPress={() => onRun(code)}
            style={({ pressed }) => [s.runBtn, pressed && s.pressed70]}
          >
            <Ionicons name="play" size={10} color={COLOR.success} />
            <Text style={s.runLabel}>Run</Text>
          </Pressable>
        ) : null}
      </View>
      <HighlightedCode code={code} lang={lang} />
    </View>
  );
}

/** Fenced-block body, syntax-highlighted. Rangi is pure JS, so desktop gets the
 *  same highlighting as mobile from the same module — this body used to render
 *  as flat unhighlighted text. */
function HighlightedCode({ code, lang }: { code: string; lang: string }) {
  const light = useColorScheme() === "light";
  const hlTheme = themeFor(light);
  const lines = useMemo(() => highlightLines(code, lang, light), [code, lang, light]);
  return (
    <Text selectable style={s.codeCardBody}>
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
}

// --- tiny markdown block renderer (pure JS/RN) ---

// Code first so ** or _ inside a code span stays literal; emphasis and links
// after. One pass over the whole string — splitting on code spans first (as
// this used to) puts the two ** markers of `**`code`**` into different pieces,
// so the emphasis never matches and the asterisks render as text.
const INLINE_RE = /(`[^`\n]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(_[^_\n]+_)|(\[[^\]]+\]\([^)]+\))/g;

/** Guards against a pathological nest; real markdown never goes this deep. */
const MAX_INLINE_DEPTH = 4;

function renderInline(
  text: string,
  keyBase: string,
  baseStyle: TextStyle,
  onUser: boolean,
  depth = 0,
): ReactNode[] {
  const out: ReactNode[] = [];
  const rx = new RegExp(INLINE_RE.source, "g");
  let last = 0;
  let m: RegExpExecArray | null;
  let si = 0;
  const plain = (from: number, to: number) => {
    if (to > from)
      out.push(
        <Text key={`${keyBase}:t${si++}`} style={baseStyle}>
          {text.slice(from, to)}
        </Text>,
      );
  };
  while ((m = rx.exec(text)) !== null) {
    plain(last, m.index);
    const tok = m[0];
    if (tok.startsWith("`")) {
      // Purple chip so inline code pops out of prose (white-on-white/20 inside
      // the accent user bubble, where purple-on-purple would vanish).
      out.push(
        <Text
          key={`${keyBase}:c${si++}`}
          style={[
            s.inlineCode,
            onUser
              ? { color: "#f4f2ff", backgroundColor: "rgba(255,255,255,0.20)" }
              : { color: "#a99cf5", backgroundColor: "rgba(124,111,240,0.16)" },
          ]}
        >
          {tok.slice(1, -1)}
        </Text>,
      );
    } else if (tok.startsWith("[")) {
      out.push(
        <Text key={`${keyBase}:l${si++}`} style={[baseStyle, s.link]}>
          {tok.slice(1, tok.indexOf("]"))}
        </Text>,
      );
    } else {
      // Emphasis: recurse so a code span (or a link) inside bold/italic still
      // renders as itself. RN nested <Text> inherits, so the merged style
      // carries down.
      const bold = tok.startsWith("**");
      const inner = bold ? tok.slice(2, -2) : tok.slice(1, -1);
      const style = [baseStyle, bold ? s.semibold : s.italic] as TextStyle[];
      out.push(
        <Text key={`${keyBase}:${bold ? "b" : "i"}${si++}`} style={style}>
          {depth < MAX_INLINE_DEPTH
            ? renderInline(
                inner,
                `${keyBase}:${si}`,
                Object.assign({}, ...style),
                onUser,
                depth + 1,
              )
            : inner}
        </Text>,
      );
    }
    last = m.index + tok.length;
  }
  plain(last, text.length);
  return out;
}

type Block =
  | { kind: "code"; lang: string; lines: string[] }
  | { kind: "heading"; level: number; text: string }
  | { kind: "quote"; lines: string[] }
  | { kind: "list"; items: { marker: string; text: string }[] }
  | { kind: "para"; lines: string[] };

function parseBlocks(src: string): Block[] {
  const lines = src.split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      const lang = line.replace(/^\s*```/, "").trim();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      i++;
      blocks.push({ kind: "code", lang, lines: body });
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      blocks.push({ kind: "heading", level: h[1].length, text: h[2] });
      i++;
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i]))
        body.push(lines[i++].replace(/^\s*>\s?/, ""));
      blocks.push({ kind: "quote", lines: body });
      continue;
    }
    const li = line.match(/^\s*([-*+]|\d+\.)\s+(.*)$/);
    if (li) {
      const items: { marker: string; text: string }[] = [];
      while (i < lines.length) {
        const m2 = lines[i].match(/^\s*([-*+]|\d+\.)\s+(.*)$/);
        if (!m2) break;
        items.push({ marker: /^\d+\.$/.test(m2[1]) ? m2[1] : "•", text: m2[2] });
        i++;
      }
      blocks.push({ kind: "list", items });
      continue;
    }
    if (line.trim() === "") {
      i++;
      continue;
    }
    const body: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^\s*(```|#{1,4}\s|>\s?|([-*+]|\d+\.)\s)/.test(lines[i])
    )
      body.push(lines[i++]);
    blocks.push({ kind: "para", lines: body });
  }
  return blocks;
}

const HEADING_STYLE: Record<number, TextStyle> = {
  1: { fontSize: 19, fontWeight: "700" },
  2: { fontSize: 17, fontWeight: "700" },
  3: { fontSize: 15.5, fontWeight: "600" },
  4: { fontSize: 15, fontWeight: "600" },
};

function Blocks({
  text,
  baseStyle,
  onUser,
}: {
  text: string;
  baseStyle: TextStyle;
  onUser: boolean;
}) {
  const blocks = parseBlocks(text);
  return (
    <View style={s.gap2}>
      {blocks.map((b, bi) => {
        switch (b.kind) {
          case "code":
            return (
              <View key={bi} style={s.codeBlock}>
                <Text selectable style={s.codeText}>
                  {b.lines.join("\n")}
                </Text>
              </View>
            );
          case "heading": {
            const headingStyle: TextStyle = { ...HEADING_STYLE[b.level], color: T.fg };
            return (
              <Text key={bi} style={headingStyle}>
                {renderInline(b.text, `h${bi}`, headingStyle, onUser)}
              </Text>
            );
          }
          case "quote": {
            const quoteStyle: TextStyle = { ...baseStyle, color: T.fgMuted };
            return (
              <View key={bi} style={s.quote}>
                <Text style={quoteStyle}>
                  {renderInline(b.lines.join("\n"), `q${bi}`, quoteStyle, onUser)}
                </Text>
              </View>
            );
          }
          case "list":
            return (
              <View key={bi} style={s.gap1}>
                {b.items.map((it, ii) => (
                  <View key={ii} style={s.listItem}>
                    <Text style={[baseStyle, s.marker]}>{it.marker}</Text>
                    {/* flexShrink (not flex:1): flex-basis 0 contributes zero
                        intrinsic width, collapsing the bubble to a skinny column. */}
                    <Text style={[{ flexShrink: 1 }, baseStyle]}>
                      {renderInline(it.text, `l${bi}:${ii}`, baseStyle, onUser)}
                    </Text>
                  </View>
                ))}
              </View>
            );
          case "para":
            return (
              <Text key={bi} style={baseStyle}>
                {b.lines.map((ln, li) => (
                  <Fragment key={li}>
                    {li > 0 ? "\n" : ""}
                    {renderInline(ln, `p${bi}:${li}`, baseStyle, onUser)}
                  </Fragment>
                ))}
              </Text>
            );
        }
      })}
    </View>
  );
}

const s = StyleSheet.create({
  gap1: { gap: 4 },
  gap2: { gap: 8 },
  cursor: { color: T.accent },
  codeCard: {
    overflow: "hidden",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: T.border,
    backgroundColor: T.bg,
  },
  codeCardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  codeLang: { fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.5, color: T.fgFaint },
  runBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderRadius: 6,
    backgroundColor: T.surfaceAlt,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  runLabel: { fontSize: 11, fontWeight: "500", color: T.fg },
  codeCardBody: {
    paddingHorizontal: 12,
    paddingBottom: 8,
    fontFamily: "JetBrainsMono",
    fontSize: 12.5,
    lineHeight: 18,
    color: T.fgMuted,
  },
  pressed70: { opacity: 0.7 },
  inlineCode: { borderRadius: 4, paddingHorizontal: 4, fontFamily: "JetBrainsMono", fontSize: 13 },
  semibold: { fontWeight: "600" },
  italic: { fontStyle: "italic" },
  link: { color: T.info, textDecorationLine: "underline" },
  codeBlock: { borderRadius: 8, backgroundColor: T.bg, paddingHorizontal: 12, paddingVertical: 8 },
  codeText: { fontFamily: "JetBrainsMono", fontSize: 12.5, lineHeight: 18, color: T.fgMuted },
  quote: { borderLeftWidth: 2, borderColor: T.borderStrong, paddingLeft: 12 },
  listItem: { flexDirection: "row", gap: 8, paddingLeft: 4 },
  marker: { color: T.fgFaint },
});
