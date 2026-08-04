/**
 * Syntax highlighting for code we render as native <Text> spans.
 *
 * Rangi over Prism: it has no DOM dependency, ships every grammar we need in
 * one zero-dependency package (~13kB), and `tokenize()` hands back plain
 * `{ text, type }` objects instead of DOM-shaped props. The Prism path needed a
 * `globalThis.Prism = …` assignment ordered before a set of static
 * `require("prismjs/components/…")` calls just to get bash, and one grammar
 * with a missing dependency could take down tokenizing everywhere.
 */
import { tokenize } from "rangi";
import { githubDark, githubLight } from "rangi/themes";

/** One run of same-colored code. `color` absent → caller uses the body color. */
export interface HlSpan {
  text: string;
  color?: string;
}

/** Tags we accept that aren't rangi language ids. Anything else is passed
 *  through — rangi returns one untyped token for a language it doesn't know,
 *  so an unknown tag degrades to plain text rather than throwing. */
const ALIAS: Record<string, string> = {
  console: "shell",
  "shell-session": "shell",
  shellsession: "shell",
  "c++": "cpp",
  "c#": "cs",
  objectivec: "c",
  objc: "c",
  yml: "yaml",
  text: "text",
  txt: "text",
  plaintext: "text",
  // Prism's umbrella id for HTML/XML/SVG, in case an old tag reaches us.
  markup: "html",
};

export function resolveLang(lang: string): string {
  const key = (lang || "").toLowerCase().trim();
  return ALIAS[key] ?? key;
}

export function themeFor(light: boolean) {
  return light ? githubLight : githubDark;
}

/**
 * Tokenize `code` and group the spans into lines.
 *
 * Tokenizing the whole string once and splitting on "\n" is required, not a
 * convenience: a token can legally span line breaks (block comments, template
 * literals, multi-line strings), and tokenizing each line separately
 * mis-highlights every one of those.
 */
export function highlightLines(code: string, lang: string, light: boolean): HlSpan[][] {
  const theme = themeFor(light);
  const lines: HlSpan[][] = [[]];
  const push = (text: string, color?: string) => {
    if (text) lines[lines.length - 1].push({ text, color });
  };
  let tokens: { text: string; type?: string }[];
  try {
    tokens = tokenize(code, { lang: resolveLang(lang) }) as { text: string; type?: string }[];
  } catch {
    // Never let a grammar problem cost us the code itself.
    return code.split("\n").map((text) => [{ text }]);
  }
  for (const token of tokens) {
    const color = token.type
      ? (theme.tokens as Record<string, string | undefined>)[token.type]
      : undefined;
    const parts = token.text.split("\n");
    parts.forEach((part, i) => {
      if (i > 0) lines.push([]);
      push(part, color);
    });
  }
  return lines;
}
