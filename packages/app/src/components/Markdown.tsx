/**
 * Minimal markdown renderer for assistant messages — pure JS/RN, no deps.
 *
 * Supports what coding agents actually emit: headings, bold/italic, inline
 * code, fenced code blocks, bullet/numbered lists, blockquotes, and links
 * (styled, non-clickable text for now). Everything else falls through as
 * plain text, so unknown syntax degrades to what mobile shows today.
 */
import { Fragment, type ReactNode } from "react";
import { Text, View } from "react-native";
import { cn } from "../ui";

/** Inline spans: `code`, **bold**, *italic* / _italic_, [label](url). */
function renderInline(text: string, keyBase: string, baseClass: string): ReactNode[] {
  const out: ReactNode[] = [];
  // Tokenize by inline-code first so markdown inside backticks stays literal.
  const parts = text.split(/(`[^`\n]+`)/g);
  parts.forEach((part, pi) => {
    if (!part) return;
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      out.push(
        <Text
          key={`${keyBase}:c${pi}`}
          className="rounded bg-surface-alt px-1 font-mono text-[13px] text-fg"
        >
          {part.slice(1, -1)}
        </Text>,
      );
      return;
    }
    // Bold / italic / links inside a non-code span.
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
        const label = tok.slice(1, tok.indexOf("]"));
        out.push(
          <Text key={`${keyBase}:l${pi}:${si++}`} className={cn(baseClass, "text-info underline")}>
            {label}
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
      i++; // closing fence
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

export function Markdown({ text, baseClass }: { text: string; baseClass: string }) {
  const blocks = parseBlocks(text);
  return (
    <View className="gap-2">
      {blocks.map((b, bi) => {
        switch (b.kind) {
          case "code":
            return (
              <View key={bi} className="rounded-lg bg-bg px-3 py-2">
                <Text className="font-mono text-[12.5px] leading-[18px] text-fg-muted">
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
                        intrinsic width, which collapses the whole bubble to a
                        skinny column. Shrink keeps natural width + wrapping. */}
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
