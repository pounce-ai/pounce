/**
 * Splitting a CLAUDE.md/AGENTS.md into commentable sections, searching them,
 * and turning the collected comments into a prompt for an agent.
 *
 * Sections are what makes the comment flow work: a note attached to "the whole
 * file" is useless to the agent, but "the ## Testing section says X and that's
 * out of date" is directly actionable. Headings are the natural unit, and every
 * one of these files is heading-structured by convention.
 */

/** One heading-delimited chunk of a context file. */
export interface ContextSection {
  /** Stable within a render: `${file}#${index}`. */
  readonly id: string;
  /** The heading text without its `#`s; null for the preamble above the first. */
  readonly heading: string | null;
  /** Heading depth (1–6); 0 for the preamble. */
  readonly level: number;
  /** The section's markdown, heading line included. */
  readonly body: string;
}

/** A user's note on one section, queued until they send it to an agent. */
export interface ContextComment {
  readonly id: string;
  /** File the note is about, e.g. `CLAUDE.md` or `.claude/CLAUDE.md`. */
  readonly file: string;
  readonly heading: string | null;
  /** Excerpt of what's being commented on — context for the agent, capped. */
  readonly quote: string;
  readonly note: string;
  readonly createdAt: string;
  /** Set when the file doesn't exist yet: the note asks for it to be created. */
  readonly missing?: true;
}

/** How much of a section travels with the note. Long enough to locate the text,
 *  short enough that ten comments don't become a wall of quoted markdown. */
export const QUOTE_MAX = 500;

const HEADING = /^(#{1,6})\s+(.*)$/;
const FENCE = /^\s*(```|~~~)/;

/**
 * Split markdown at ATX headings, fence-aware.
 *
 * The fence tracking is the part that matters: these files are full of shell
 * and config samples, and `# comment` inside a bash block is a comment, not a
 * heading. Splitting on it would slice a code block in half and produce a
 * section the agent can't act on.
 */
export function splitSections(content: string, file: string): ContextSection[] {
  const lines = content.split("\n");
  const out: ContextSection[] = [];
  let buf: string[] = [];
  let heading: string | null = null;
  let level = 0;
  let fence: string | null = null;

  const flush = () => {
    // Drop a trailing run of blank lines but keep interior spacing.
    while (buf.length && !buf[buf.length - 1].trim()) buf.pop();
    if (!buf.length && heading === null) return; // leading blank preamble
    out.push({ id: `${file}#${out.length}`, heading, level, body: buf.join("\n") });
    buf = [];
  };

  for (const line of lines) {
    const f = FENCE.exec(line);
    if (f) {
      // Closing marker must match the one that opened the fence, so a ``` block
      // containing ~~~ (or vice versa) stays one block.
      if (fence && line.trim().startsWith(fence)) fence = null;
      else if (!fence) fence = f[1];
      buf.push(line);
      continue;
    }
    const m = fence ? null : HEADING.exec(line);
    if (m) {
      flush();
      level = m[1].length;
      heading = m[2].trim();
      buf.push(line);
      continue;
    }
    buf.push(line);
  }
  flush();
  return out;
}

/** Case-insensitive occurrence count. Empty/whitespace query counts as none. */
export function countMatches(text: string, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const hay = text.toLowerCase();
  let n = 0;
  let i = hay.indexOf(q);
  while (i !== -1) {
    n++;
    i = hay.indexOf(q, i + q.length);
  }
  return n;
}

/** Sections containing the query, with their hit counts, in document order. */
export function findMatches(
  sections: readonly ContextSection[],
  query: string,
): { section: ContextSection; count: number }[] {
  if (!query.trim()) return [];
  return sections
    .map((section) => ({ section, count: countMatches(section.body, query) }))
    .filter((m) => m.count > 0);
}

/**
 * Split text into alternating plain/matched runs for highlighted rendering.
 *
 * Needed because the native markdown renderer draws a whole block at once and
 * can't tint a substring — a matched section falls back to plain `<Text>` runs
 * so the hit is actually visible.
 */
export function splitHighlight(text: string, query: string): { text: string; match: boolean }[] {
  const q = query.trim();
  if (!q) return [{ text, match: false }];
  const hay = text.toLowerCase();
  const needle = q.toLowerCase();
  const parts: { text: string; match: boolean }[] = [];
  let at = 0;
  let i = hay.indexOf(needle);
  while (i !== -1) {
    if (i > at) parts.push({ text: text.slice(at, i), match: false });
    parts.push({ text: text.slice(i, i + needle.length), match: true });
    at = i + needle.length;
    i = hay.indexOf(needle, at);
  }
  if (at < text.length) parts.push({ text: text.slice(at), match: false });
  return parts;
}

/**
 * Normalize markdown down to roughly what the renderer DREW.
 *
 * A selection comes back as displayed text — "Package manager is Bun" — while
 * the source says "Package manager is **Bun**". Comparing the two raw fails on
 * any selection that crosses an emphasis, code span, or link, which is most of
 * a sentence in these files. Stripping the inline syntax (and collapsing the
 * whitespace the renderer re-wrapped) makes the two comparable.
 *
 * Deliberately approximate: this feeds a fuzzy lookup whose failure mode is a
 * comment with no section name, not a wrong edit.
 */
function loose(s: string): string {
  return s
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // links/images → their text
    .replace(/[`*_~]/g, "") // emphasis, code spans, strikethrough
    .replace(/^\s{0,3}#{1,6}\s+/gm, "") // heading markers
    .replace(/^\s{0,3}>\s?/gm, "") // blockquote markers
    .replace(/^\s*(?:[-+*]|\d+\.)\s+/gm, "") // list bullets
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Which section a piece of selected text came from.
 *
 * The selection arrives as TEXT, not as an offset into the source: the native
 * renderer reports positions in what it drew, and what it drew has had the
 * markdown syntax stripped out. So the section is recovered by finding the
 * selection's opening words back in the source. Whitespace is normalized
 * because the renderer re-wraps lines.
 *
 * Returns null when the text can't be placed — a selection spanning a heading
 * boundary, or one whose markdown punctuation the renderer swallowed. The
 * comment is still perfectly usable then; it just travels without a section
 * name, and the quote itself tells the agent where to look.
 */
export function sectionForText(
  sections: readonly ContextSection[],
  selected: string,
): ContextSection | null {
  const needle = loose(selected);
  if (needle.length < MIN_PROBE) return null;
  const bodies = sections.map((s) => loose(s.body));

  // Longest prefix first, and it must land in exactly ONE section.
  //
  // Uniqueness is the important half. A short selection ("agent") appears all
  // over a document, and picking the first section that contains it names the
  // wrong one — which is worse than naming none, because a wrong heading sends
  // the agent to edit a passage the user never looked at. Ambiguous → null, and
  // the quote alone locates the change.
  //
  // Shrinking handles the other case: a selection running past a heading
  // matches no section in full, but its opening still says where it started.
  // Shrink gently (×0.7, not halving): a selection that just misses at full
  // length is usually only a few characters past a boundary, and a coarse step
  // can jump straight under MIN_PROBE and give up on a placeable selection.
  for (let len = needle.length; len >= MIN_PROBE; len = Math.floor(len * 0.7)) {
    const probe = needle.slice(0, len);
    const found: number[] = [];
    for (let i = 0; i < bodies.length; i++) if (bodies[i].includes(probe)) found.push(i);
    if (found.length === 1) return sections[found[0]];
    if (found.length > 1) return null; // genuinely ambiguous — don't guess
  }
  return null;
}

/** Shortest selection worth trying to place. Below this, a match says almost
 *  nothing about where the user was reading. */
const MIN_PROBE = 12;

/** A section's markdown with its heading line removed — the heading is rendered
 *  separately wherever the body is shown raw. */
export function bodyOf(section: ContextSection): string {
  if (section.heading === null) return section.body;
  return section.body.split("\n").slice(1).join("\n").trim();
}

/** A section's body, for a comment's quote. Falls back to the heading for a
 *  section that is nothing but a heading. */
export function quoteFor(section: ContextSection): string {
  const text = bodyOf(section).trim() || section.heading || "";
  return text.length > QUOTE_MAX ? text.slice(0, QUOTE_MAX) + "…" : text;
}

/**
 * The prompt that carries the user's notes into a new thread.
 *
 * Phrased as a scoped edit request, not an open invitation: an agent handed
 * "improve the docs" will rewrite the file wholesale, and the user asked for
 * three specific changes. The instruction to leave everything else alone is
 * what keeps the resulting diff reviewable.
 */
export function buildContextChangeRequest(opts: {
  cwd: string | null;
  comments: readonly ContextComment[];
}): string {
  const { cwd, comments } = opts;
  if (!comments.length) return "";

  const byFile = new Map<string, ContextComment[]>();
  for (const c of comments) {
    const list = byFile.get(c.file);
    if (list) list.push(c);
    else byFile.set(c.file, [c]);
  }

  const where = cwd ? ` in ${cwd}` : "";
  const files = [...byFile.keys()];
  const parts: string[] = [
    `Please update this project's agent context files${where} based on the review notes below.`,
    `Files to edit: ${files.join(", ")}.`,
    "Apply each note directly in the file it names, match the existing tone and structure, and leave everything the notes don't mention unchanged.",
  ];

  for (const [file, list] of byFile) {
    for (const c of list) {
      // Every note names its own file. A group header would put the filename
      // an arbitrary number of lines above the request it applies to, which is
      // exactly the thing an agent skims past on a long list.
      const where2 = c.missing
        ? `${file} — does not exist yet`
        : c.heading
          ? `${file} — section "${c.heading}"`
          : file;
      parts.push(`\n### ${where2}`);
      if (c.quote.trim()) {
        parts.push(
          c.quote
            .split("\n")
            .map((l) => `> ${l}`)
            .join("\n"),
        );
      }
      parts.push(`\nRequested change: ${c.note.trim()}`);
    }
  }
  return parts.join("\n");
}
