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
import { Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { cn, COLOR } from "../ui";
import { splitCodeBlocks } from "./runnableBlocks";

const BASE: Record<"user" | "assistant", string> = {
  user: "text-[15px] leading-[21px] text-white",
  assistant: "text-[15px] leading-[21px] text-fg",
};

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
  const base = BASE[role];
  // Settled assistant turns get code blocks lifted out (Run cards); streaming
  // turns render on the single path (incomplete fences would mis-split).
  const highlight = role === "assistant" && !streaming;
  const segments = useMemo(() => (highlight ? splitCodeBlocks(text) : null), [highlight, text]);

  if (!highlight || !segments || (segments.length === 1 && segments[0].type === "md")) {
    return (
      <View className="gap-2">
        <Blocks text={text} baseClass={base} />
        {streaming ? <Text className="text-accent">▋</Text> : null}
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
          <Blocks key={`m${i}`} text={seg.text} baseClass={base} />
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
    <View className="overflow-hidden rounded-lg border border-border bg-bg">
      <View className="flex-row items-center justify-between px-3 py-1">
        <Text className="text-[10.5px] uppercase tracking-wide text-fg-faint">{lang || "code"}</Text>
        {onRun ? (
          <Pressable
            onPress={() => onRun(code)}
            className="active:opacity-70 flex-row items-center gap-1 rounded-md bg-surface-alt px-2 py-0.5"
          >
            <Ionicons name="play" size={10} color={COLOR.success} />
            <Text className="text-[11px] font-medium text-fg">Run</Text>
          </Pressable>
        ) : null}
      </View>
      <Text selectable className="px-3 pb-2 font-mono text-[12.5px] leading-[18px] text-fg-muted">
        {code}
      </Text>
    </View>
  );
}

// --- tiny markdown block renderer (pure JS/RN) ---

function renderInline(text: string, keyBase: string, baseClass: string): ReactNode[] {
  const out: ReactNode[] = [];
  const parts = text.split(/(`[^`\n]+`)/g);
  parts.forEach((part, pi) => {
    if (!part) return;
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      // Purple chip so inline code pops out of prose (white-on-white/20 inside
      // the accent user bubble, where purple-on-purple would vanish).
      const onUser = baseClass.includes("text-white");
      out.push(
        <Text
          key={`${keyBase}:c${pi}`}
          className="rounded px-1 font-mono text-[13px]"
          style={
            onUser
              ? { color: "#f4f2ff", backgroundColor: "rgba(255,255,255,0.20)" }
              : { color: "#a99cf5", backgroundColor: "rgba(124,111,240,0.16)" }
          }
        >
          {part.slice(1, -1)}
        </Text>,
      );
      return;
    }
    const rx = /(\*\*[^*]+\*\*|\*[^*\n]+\*|_[^_\n]+_|\[[^\]]+\]\([^)]+\))/g;
    let last = 0;
    let m: RegExpExecArray | null;
    let si = 0;
    while ((m = rx.exec(part)) !== null) {
      if (m.index > last) {
        out.push(
          <Text key={`${keyBase}:t${pi}:${si++}`} className={baseClass}>
            {part.slice(last, m.index)}
          </Text>,
        );
      }
      const tok = m[0];
      if (tok.startsWith("**")) {
        out.push(
          <Text key={`${keyBase}:b${pi}:${si++}`} className={cn(baseClass, "font-semibold")}>
            {tok.slice(2, -2)}
          </Text>,
        );
      } else if (tok.startsWith("[")) {
        out.push(
          <Text key={`${keyBase}:l${pi}:${si++}`} className={cn(baseClass, "text-info underline")}>
            {tok.slice(1, tok.indexOf("]"))}
          </Text>,
        );
      } else {
        out.push(
          <Text key={`${keyBase}:i${pi}:${si++}`} className={cn(baseClass, "italic")}>
            {tok.slice(1, -1)}
          </Text>,
        );
      }
      last = m.index + tok.length;
    }
    if (last < part.length) {
      out.push(
        <Text key={`${keyBase}:t${pi}:end`} className={baseClass}>
          {part.slice(last)}
        </Text>,
      );
    }
  });
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
    while (i < lines.length && lines[i].trim() !== "" && !/^\s*(```|#{1,4}\s|>\s?|([-*+]|\d+\.)\s)/.test(lines[i]))
      body.push(lines[i++]);
    blocks.push({ kind: "para", lines: body });
  }
  return blocks;
}

const HEADING_CLASS: Record<number, string> = {
  1: "text-[19px] font-bold",
  2: "text-[17px] font-bold",
  3: "text-[15.5px] font-semibold",
  4: "text-[15px] font-semibold",
};

function Blocks({ text, baseClass }: { text: string; baseClass: string }) {
  const blocks = parseBlocks(text);
  return (
    <View className="gap-2">
      {blocks.map((b, bi) => {
        switch (b.kind) {
          case "code":
            return (
              <View key={bi} className="rounded-lg bg-bg px-3 py-2">
                <Text selectable className="font-mono text-[12.5px] leading-[18px] text-fg-muted">
                  {b.lines.join("\n")}
                </Text>
              </View>
            );
          case "heading":
            return (
              <Text key={bi} className={cn(HEADING_CLASS[b.level], "text-fg")}>
                {renderInline(b.text, `h${bi}`, cn(HEADING_CLASS[b.level], "text-fg"))}
              </Text>
            );
          case "quote":
            return (
              <View key={bi} className="border-l-2 border-border-strong pl-3">
                <Text className={cn(baseClass, "text-fg-muted")}>
                  {renderInline(b.lines.join("\n"), `q${bi}`, cn(baseClass, "text-fg-muted"))}
                </Text>
              </View>
            );
          case "list":
            return (
              <View key={bi} className="gap-1">
                {b.items.map((it, ii) => (
                  <View key={ii} className="flex-row gap-2 pl-1">
                    <Text className={cn(baseClass, "text-fg-faint")}>{it.marker}</Text>
                    {/* flexShrink (not flex-1): flex-basis 0 contributes zero
                        intrinsic width, collapsing the bubble to a skinny column. */}
                    <Text style={{ flexShrink: 1 }} className={baseClass}>
                      {renderInline(it.text, `l${bi}:${ii}`, baseClass)}
                    </Text>
                  </View>
                ))}
              </View>
            );
          case "para":
            return (
              <Text key={bi} className={baseClass}>
                {b.lines.map((ln, li) => (
                  <Fragment key={li}>
                    {li > 0 ? "\n" : ""}
                    {renderInline(ln, `p${bi}:${li}`, baseClass)}
                  </Fragment>
                ))}
              </Text>
            );
        }
      })}
    </View>
  );
}
